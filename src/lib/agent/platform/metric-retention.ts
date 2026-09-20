import { runTaskLoop } from "thesidedoor-core/runtime/task-loop";
import { dataRoot } from "../../data-dir";
import { AgentMetrics } from "./metrics";

interface RetentionWorker {
  directory: string;
  controller: AbortController;
  completion: Promise<void>;
  lastSuccess: number | null;
  failures: number;
  failed: boolean;
}

const runtime = globalThis as typeof globalThis & {
  papernookMetricRetention?: RetentionWorker;
};

/** Prune immediately and hourly even when no invocation writes new events. */
export function startMetricRetention(): void {
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  const directory = dataRoot();
  const current = runtime.papernookMetricRetention;
  if (current) {
    if (current.failed || current.controller.signal.aborted)
      throw new Error("Await metric retention shutdown before restarting it.");
    if (current.directory !== directory)
      throw new Error(
        "Metric retention is already running for another data directory.",
      );
    return;
  }
  const metrics = new AgentMetrics(directory);
  const worker: RetentionWorker = {
    directory,
    controller: new AbortController(),
    completion: Promise.resolve(),
    lastSuccess: null,
    failures: 0,
    failed: false,
  };
  runtime.papernookMetricRetention = worker;
  worker.completion = runTaskLoop({
    intervalMs: 60 * 60 * 1000,
    signal: worker.controller.signal,
    task: async () => {
      await metrics.prune();
      worker.lastSuccess = Date.now();
    },
    onError: () => {
      worker.failures = Math.min(Number.MAX_SAFE_INTEGER, worker.failures + 1);
    },
  }).catch(() => {
    worker.failed = true;
  });
}

export function metricRetentionStatus() {
  const worker = runtime.papernookMetricRetention;
  return {
    running: Boolean(
      worker && !worker.failed && !worker.controller.signal.aborted,
    ),
    lastSuccess: worker?.lastSuccess ?? null,
    failures: worker?.failures ?? 0,
    failed: worker?.failed ?? false,
  };
}

/** Await any atomic prune already in progress before releasing the runtime. */
export async function stopMetricRetention(): Promise<void> {
  const worker = runtime.papernookMetricRetention;
  if (!worker) return;
  worker.controller.abort();
  await worker.completion;
  if (runtime.papernookMetricRetention === worker)
    delete runtime.papernookMetricRetention;
}
