import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let tmpDir: string;
let child: ChildProcess | null;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "papernook-auth-sync-"));
  child = null;
});

afterEach(() => {
  child?.kill("SIGTERM");
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Credential sync script did not reach the expected state.");
}

describe("credential sync sidecar script", () => {
  it("observes atomic login replacement and removes credentials on logout", async () => {
    const sync = path.join(tmpDir, "sync");
    const claude = path.join(tmpDir, "claude");
    const codex = path.join(tmpDir, "codex");
    fs.mkdirSync(claude);
    fs.mkdirSync(codex);
    const source = path.join(claude, ".credentials.json");
    fs.writeFileSync(source, '{"token":"old"}', { mode: 0o600 });

    child = spawn(
      "sh",
      [path.join(process.cwd(), "scripts/agent/sync-cli-credentials.sh")],
      {
        env: {
          ...process.env,
          PAPERNOOK_SYNC_ROOT: sync,
          PAPERNOOK_HOST_CLAUDE_DIR: claude,
          PAPERNOOK_HOST_CODEX_DIR: codex,
        },
        stdio: "ignore",
      },
    );
    await waitFor(() => fs.existsSync(path.join(sync, "ready")));
    expect(
      fs.readFileSync(path.join(sync, "claude-credentials.json"), "utf8"),
    ).toBe('{"token":"old"}');

    const replacement = path.join(claude, ".credentials.new");
    fs.writeFileSync(replacement, '{"token":"new"}', { mode: 0o600 });
    fs.renameSync(replacement, source);
    fs.writeFileSync(path.join(sync, "requests", "login"), "");
    await waitFor(() => fs.existsSync(path.join(sync, "responses", "login")));
    expect(
      fs.readFileSync(path.join(sync, "claude-credentials.json"), "utf8"),
    ).toBe('{"token":"new"}');

    fs.rmSync(source);
    fs.writeFileSync(path.join(sync, "requests", "logout"), "");
    await waitFor(() => fs.existsSync(path.join(sync, "responses", "logout")));
    expect(fs.existsSync(path.join(sync, "claude-credentials.json"))).toBe(
      false,
    );
  });
});
