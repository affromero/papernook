import { runTaskLoop } from "thesidedoor-core/runtime/task-loop";
import path from "node:path";
import { FileLockBusyError } from "thesidedoor-core/storage";
import { dataRoot } from "../../data-dir";
import { ERASURE_READY, PapernookIdentityStore } from "../identity-store";
import { ProfileOperations } from "../profile-operations";
import { eraseProfileFiles } from "../users";

export interface ErasureDiagnostic {
  username: string;
  generation: number;
  status: "waiting" | "failed";
}

/** Each cleanup rechecks its exact tombstone under the exclusive profile lease. */
export async function runErasurePass(
  identity: PapernookIdentityStore,
  signal: AbortSignal,
): Promise<ErasureDiagnostic[]> {
  if (identity.file !== path.join(dataRoot(), "identity.json"))
    throw new Error(
      "Erasure data directory does not match the identity store.",
    );
  const snapshot = await identity.read();
  if (!snapshot.access.initializations.includes(ERASURE_READY))
    throw new Error(
      "Run the local access migration before processing erasures.",
    );
  const diagnostics: ErasureDiagnostic[] = [];
  const operations = new ProfileOperations(identity);
  for (const marker of snapshot.erasures) {
    if (signal.aborted) break;
    try {
      await operations.finishErasure(
        marker.username,
        marker.generation,
        async () => {
          eraseProfileFiles(marker.username);
        },
        { signal },
      );
    } catch (error) {
      if (signal.aborted) break;
      diagnostics.push({
        ...marker,
        status: error instanceof FileLockBusyError ? "waiting" : "failed",
      });
    }
  }
  return diagnostics;
}

interface Worker {
  directory: string;
  diagnostics: ErasureDiagnostic[];
  controller: AbortController;
  completion: Promise<void>;
  failed: boolean;
}
const runtime = globalThis as typeof globalThis & {
  papernookErasureWorker?: Worker;
};

export function startErasureWorker(): void {
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  const directory = dataRoot();
  if (runtime.papernookErasureWorker) {
    if (runtime.papernookErasureWorker.directory !== directory)
      throw new Error(
        "Erasure worker is already running for another data directory.",
      );
    return;
  }
  const identity = new PapernookIdentityStore(directory);
  if (!identity.readSnapshot().access.initializations.includes(ERASURE_READY))
    throw new Error(
      "Run the local access migration before starting Papernook.",
    );
  const controller = new AbortController();
  const worker: Worker = {
    directory,
    diagnostics: [],
    controller,
    completion: Promise.resolve(),
    failed: false,
  };
  runtime.papernookErasureWorker = worker;
  worker.completion = runTaskLoop({
    intervalMs: 30_000,
    signal: controller.signal,
    task: async (signal) => {
      worker.diagnostics = await runErasurePass(identity, signal);
    },
    onError: () => {
      console.error("papernook erasure: storage unavailable; retry scheduled");
    },
  }).catch(() => {
    worker.failed = true;
    console.error("papernook erasure: worker stopped unexpectedly");
  });
}

export function erasureWorkerStatus() {
  const worker = runtime.papernookErasureWorker;
  return {
    running: Boolean(
      worker && !worker.failed && !worker.controller.signal.aborted,
    ),
    diagnostics: worker?.diagnostics.map((entry) => ({ ...entry })) ?? [],
  };
}

export async function stopErasureWorker(): Promise<void> {
  const worker = runtime.papernookErasureWorker;
  if (!worker) return;
  worker.controller.abort();
  await worker.completion;
  if (runtime.papernookErasureWorker === worker)
    delete runtime.papernookErasureWorker;
}
