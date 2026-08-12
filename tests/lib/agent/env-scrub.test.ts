import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `codex exec -s read-only` blocks writes, not reads, and the turn it runs is
 * steered by paper text an attacker may control. Whatever the sandbox lets it
 * read, the app's secrets must not be sitting in its environment.
 */

const SECRETS = {
  PAPERNOOK_PASSWORD: "the-instance-access-password",
  WEBDAV_PASS: "the-webdav-password",
  SESSION_SECRET: "s".repeat(64),
  OPENAI_API_KEY: "sk-openai-secret",
  AWS_SECRET_ACCESS_KEY: "aws-secret",
};

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("PATH", "/usr/bin");
  vi.stubEnv("HOME", "/home/node");
  for (const [key, value] of Object.entries(SECRETS)) vi.stubEnv(key, value);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("CLI provider environment", () => {
  it("hands codex no app secret, only what it needs to run", async () => {
    vi.stubEnv("CODEX_SSH_HOST", "you@vps");
    const { codexEnvironment } = await import("@/lib/agent/codex");

    const env = codexEnvironment();

    for (const key of Object.keys(SECRETS)) {
      expect(env[key], key).toBeUndefined();
    }
    expect(Object.values(env)).not.toContain(SECRETS.PAPERNOOK_PASSWORD);
    // Still runnable, and its own namespace survives.
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/node");
    expect(env.CODEX_SSH_HOST).toBe("you@vps");
  });

  it("hands claude-code its own credentials but no unrelated secret", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "claude-oauth-token");
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-key");
    const { claudeCodeEnvironment } = await import("@/lib/agent/claude-code");

    const env = claudeCodeEnvironment();

    expect(env.PAPERNOOK_PASSWORD).toBeUndefined();
    expect(env.WEBDAV_PASS).toBeUndefined();
    expect(env.SESSION_SECRET).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    // The provider's own auth must still reach it, or every turn fails.
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("claude-oauth-token");
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-key");
    expect(env.PATH).toBe("/usr/bin");
  });
});
