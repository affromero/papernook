import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let tmpDir: string;
let syncDir: string;
let runtimeHome: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "papernook-credentials-"));
  syncDir = path.join(tmpDir, "sync");
  runtimeHome = path.join(tmpDir, "home");
  fs.mkdirSync(path.join(syncDir, "requests"), { recursive: true });
  fs.mkdirSync(path.join(syncDir, "responses"), { recursive: true });
  fs.writeFileSync(path.join(syncDir, "supports-claude"), "");
  fs.writeFileSync(path.join(syncDir, "supports-codex"), "");
  vi.stubEnv("PAPERNOOK_CREDENTIAL_SYNC_DIR", syncDir);
  vi.stubEnv("HOME", runtimeHome);
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function answerSync(
  provider: "claude-code" | "codex",
  snapshot: object | null,
): Promise<void> {
  const requests = path.join(syncDir, "requests");
  let request: string | undefined;
  for (let attempt = 0; attempt < 50 && !request; attempt += 1) {
    request = fs.readdirSync(requests)[0];
    if (!request) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (!request) throw new Error("Credential reload did not request a sync.");
  const snapshotPath = path.join(
    syncDir,
    provider === "claude-code" ? "claude-credentials.json" : "codex-auth.json",
  );
  if (snapshot) fs.writeFileSync(snapshotPath, JSON.stringify(snapshot));
  else fs.rmSync(snapshotPath, { force: true });
  fs.writeFileSync(path.join(syncDir, "responses", request), "");
}

describe("CLI credential reload", () => {
  it("installs the sidecar snapshot atomically into the CLI home", async () => {
    const credentials = await import("@/lib/agent/credentials");
    const reload = credentials.reloadProviderCredentials("claude-code");
    await answerSync("claude-code", {
      claudeAiOauth: { accessToken: "new-token" },
    });
    await reload;

    const installed = fs.readFileSync(
      path.join(runtimeHome, ".claude", ".credentials.json"),
      "utf8",
    );
    expect(JSON.parse(installed)).toEqual({
      claudeAiOauth: { accessToken: "new-token" },
    });
  });

  it("removes runtime credentials when the host is logged out", async () => {
    const runtime = path.join(runtimeHome, ".claude", ".credentials.json");
    fs.mkdirSync(path.dirname(runtime), { recursive: true });
    fs.writeFileSync(runtime, '{"stale":true}');
    const credentials = await import("@/lib/agent/credentials");
    const reload = credentials.reloadProviderCredentials("claude-code");
    await answerSync("claude-code", null);
    await reload;

    expect(fs.existsSync(runtime)).toBe(false);
  });

  it("reloads Codex login into its CLI home", async () => {
    const credentials = await import("@/lib/agent/credentials");
    const reload = credentials.reloadProviderCredentials("codex");
    await answerSync("codex", {
      tokens: { access_token: "new-codex-token" },
    });
    await reload;

    const installed = fs.readFileSync(
      path.join(runtimeHome, ".codex", "auth.json"),
      "utf8",
    );
    expect(JSON.parse(installed)).toEqual({
      tokens: { access_token: "new-codex-token" },
    });
  });

  it("serializes different providers without treating one as the other", async () => {
    const credentials = await import("@/lib/agent/credentials");
    const claudeReload = credentials.reloadProviderCredentials("claude-code");
    const codexReload = credentials.reloadProviderCredentials("codex");

    await answerSync("claude-code", { claude: "fresh" });
    await claudeReload;
    await answerSync("codex", { codex: "fresh" });
    await codexReload;

    expect(
      JSON.parse(
        fs.readFileSync(
          path.join(runtimeHome, ".claude", ".credentials.json"),
          "utf8",
        ),
      ),
    ).toEqual({ claude: "fresh" });
    expect(
      JSON.parse(
        fs.readFileSync(path.join(runtimeHome, ".codex", "auth.json"), "utf8"),
      ),
    ).toEqual({ codex: "fresh" });
  });

  it("does not offer local credential reload for SSH providers", async () => {
    vi.stubEnv("CLAUDE_CODE_SSH_HOST", "agent-host");
    vi.resetModules();
    const { credentialReloadAvailable } =
      await import("@/lib/agent/credentials");

    expect(credentialReloadAvailable("claude-code")).toBe(false);
    expect(credentialReloadAvailable("anthropic")).toBe(false);
  });

  it("does not offer local credential reload for SSH Codex", async () => {
    vi.stubEnv("CODEX_SSH_HOST", "agent-host");
    vi.resetModules();
    const { credentialReloadAvailable } =
      await import("@/lib/agent/credentials");

    expect(credentialReloadAvailable("codex")).toBe(false);
  });
});
