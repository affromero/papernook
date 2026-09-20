import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProcessRunner } from "thesidedoor-core/runtime/process";
import { agentEnvironment } from "thesidedoor-core/runtime/environment";
import { executeCodex, streamCodex } from "@/lib/agent/codex";
import { providerStatus } from "@/lib/agent/registry";
import { stageImagesOverSsh } from "@/lib/agent/attachments";
import { buildAgentInvocation } from "@/lib/agent/invocation";
import { configureTestAgent } from "../../../helpers/agent";

const enabled = process.env.SIDEDOOR_TEST_SSH_HOST === "root@127.0.0.1";
describe.skipIf(!enabled)("disposable SSH acceptance", () => {
  let directory: string;
  beforeEach(async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "papernook-live-ssh-"));
    vi.stubEnv("PAPERNOOK_DATA_DIR", directory);
    vi.stubEnv("CODEX_SSH_HOST", "root@127.0.0.1");
    await configureTestAgent({ provider: "codex" });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it("checks readiness and executes through the real SSH supervisor", async () => {
    expect(await providerStatus("codex")).toBe("ready");
    expect(
      await executeCodex({
        system: "",
        prompt: "question",
        metricOwner: "instance",
      }),
    ).toBe("remote answer");
  });

  it("transfers same-name images separately and removes their remote directory", async () => {
    const files = ["first", "second"].map((name) => {
      const folder = path.join(directory, name);
      fs.mkdirSync(folder);
      const file = path.join(folder, "image.png");
      fs.writeFileSync(file, name);
      return file;
    });
    const staged = await stageImagesOverSsh(files, "root@127.0.0.1");
    const runner = new ProcessRunner();
    try {
      const result = await runner.execute({
        ...buildAgentInvocation(
          "python3",
          [
            "-c",
            "import json,pathlib,sys; print(json.dumps([pathlib.Path(p).read_text() for p in sys.argv[1:]]))",
            ...staged.paths,
          ],
          "root@127.0.0.1",
        ),
        environment: agentEnvironment(process.env),
        timeoutMs: 5000,
      });
      expect(JSON.parse(result.stdout)).toEqual(["first", "second"]);
    } finally {
      await staged.cleanup();
    }
    const result = await runner.execute({
      ...buildAgentInvocation(
        "python3",
        [
          "-c",
          "import pathlib,sys; sys.exit(pathlib.Path(sys.argv[1]).exists())",
          path.dirname(path.dirname(staged.paths[0]!)),
        ],
        "root@127.0.0.1",
      ),
      environment: agentEnvironment(process.env),
      timeoutMs: 5000,
    });
    expect(result.stderr).toBe("");
  });

  it("stops the remote process group after cancellation over SSH", async () => {
    const stream = streamCodex({
      system: "",
      prompt: "hold remote process",
      metricOwner: "instance",
    });
    const first = await stream.next();
    const remote: { pid: number; child: number } = JSON.parse(first.value!);
    const pending = stream.next();
    const returned = stream.return(undefined);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await returned;
    const runner = new ProcessRunner();
    await vi.waitFor(
      async () => {
        const result = await runner.execute({
          command: "docker",
          args: [
            "exec",
            "sidedoor-ssh-acceptance-20260912",
            "python3",
            "-c",
            "import pathlib,sys; states=[p.read_text().split(') ')[1][0] for n in sys.argv[1:] if (p:=pathlib.Path('/proc')/n/'stat').exists()]; print(states); sys.exit(any(s!='Z' for s in states))",
            String(remote.pid),
            String(remote.child),
          ],
          environment: agentEnvironment(process.env),
          timeoutMs: 3000,
        });
        expect(result.stderr).toBe("");
      },
      { timeout: 5000 },
    );
  });
});
