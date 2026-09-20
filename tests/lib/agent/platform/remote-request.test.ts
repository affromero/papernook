import { expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { configureTestAgent } from "../../../helpers/agent";
import { providerStatus } from "@/lib/agent/registry";
import { ProcessRunner } from "thesidedoor-core/runtime/process";
import { remoteSupervisor } from "thesidedoor-core/runtime/ssh";
import { agentProcessRequest } from "@/lib/agent/invocation";

it("routes remote CLI work through a supervisor with remote credentials and a held-open transport", async () => {
  const request = agentProcessRequest({
    cli: "codex",
    args: ["exec", "-"],
    input: "private prompt",
    sshHost: "owner@host",
    environment: { PATH: process.env.PATH, CODEX_API_KEY: "local-key" },
    timeoutMs: 1000,
  });
  expect(request.command).toBe("ssh");
  expect(request.keepInputOpen).toBe(true);
  expect(request.args.at(-1)).toContain("python3");
  expect(request.environment).not.toHaveProperty("CODEX_API_KEY");
  const payload = JSON.parse(String(request.input));
  expect(payload.environmentKeys).toContain("CODEX_API_KEY");
  expect(payload.environmentKeys).not.toContain("ANTHROPIC_API_KEY");
  expect(payload.environment).toEqual({});
  // Substitute only SSH transport. Execute the actual supervisor and its owned child.
  payload.argv = [
    process.execPath,
    "-e",
    "let input='';process.stdin.on('data',x=>input+=x);process.stdin.on('end',()=>console.log(JSON.stringify({input,key:process.env.CODEX_API_KEY,secret:process.env.APP_SECRET})));",
  ];
  const result = await new ProcessRunner().execute({
    ...request,
    command: "python3",
    args: ["-c", remoteSupervisor],
    input: JSON.stringify(payload) + "\n",
    environment: {
      ...request.environment,
      CODEX_API_KEY: "remote-key",
      APP_SECRET: "private-app-value",
    },
  });
  expect(JSON.parse(result.stdout)).toEqual({
    input: "private prompt",
    key: "remote-key",
  });
});

it("requires supervised remote readiness before reporting a CLI as ready", async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "papernook-remote-readiness-"),
  );
  try {
    vi.stubEnv("PAPERNOOK_DATA_DIR", directory);
    vi.stubEnv("PATH", directory + path.delimiter + process.env.PATH);
    vi.stubEnv("CODEX_SSH_HOST", "fixture-host");
    await configureTestAgent({ provider: "codex" });
    const executable = (body: string) =>
      fs.writeFileSync(
        path.join(directory, "ssh"),
        `#!${process.execPath}\n${body}`,
        { mode: 0o700 },
      );
    executable(
      `process.exit(process.argv.at(-1).includes('python3') ? 127 : 0);`,
    );
    expect(await providerStatus("codex")).toBe("unreachable");
    executable(
      `let text='';process.stdin.on('data',chunk=>{text+=chunk;if(text.endsWith('\\n')){const p=JSON.parse(text);process.exit(p.argv.includes('--version')?0:1);}});`,
    );
    expect(await providerStatus("codex")).toBe("not_authenticated");
    executable(`process.stdin.on('data',()=>process.exit(0));`);
    expect(await providerStatus("codex")).toBe("ready");
  } finally {
    vi.unstubAllEnvs();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
