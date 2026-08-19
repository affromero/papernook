import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    vi.stubEnv("CODEX_HOME", "/home/node/.codex");
    vi.stubEnv("CODEX_SSH_HOST", "you@vps");
    vi.stubEnv("CODEX_INTERNAL_TOKEN", "a-future-secret");
    const { codexEnvironment } = await import("@/lib/agent/codex");

    const env = codexEnvironment();

    for (const key of Object.keys(SECRETS)) {
      expect(env[key], key).toBeUndefined();
    }
    expect(Object.values(env)).not.toContain(SECRETS.PAPERNOOK_PASSWORD);
    // Named keys, not a CODEX_ prefix sweep: a variable added later is
    // absent by default rather than inherited because of how it is spelled.
    expect(env.CODEX_INTERNAL_TOKEN).toBeUndefined();
    // The app reads the SSH host to build the argv; the child never needs it.
    expect(env.CODEX_SSH_HOST).toBeUndefined();
    // Still runnable.
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/node");
    expect(env.CODEX_HOME).toBe("/home/node/.codex");
  });

  it("hands claude-code its own credentials but no unrelated secret", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "claude-oauth-token");
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-key");
    const { createClaudeInvocation } = await import("@/lib/agent/claude-code");

    const invocation = createClaudeInvocation();
    const env = invocation.env;
    invocation.release();

    expect(env.PAPERNOOK_PASSWORD).toBeUndefined();
    expect(env.WEBDAV_PASS).toBeUndefined();
    expect(env.SESSION_SECRET).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    // The provider's own auth must still reach it, or every turn fails.
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("claude-oauth-token");
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-key");
    expect(env.PATH).toBe("/usr/bin");
  });

  it("preserves the container's credential path for claude-code", async () => {
    // How production actually authenticates: docker-entrypoint.sh copies the
    // host credentials to /home/node/.claude/.credentials.json and the CLI
    // finds them through HOME. Stripping HOME would silently break every
    // chat with a "needs login" that looks like an expired token.
    vi.stubEnv("HOME", "/home/node");
    const { createClaudeInvocation } = await import("@/lib/agent/claude-code");

    const invocation = createClaudeInvocation();
    expect(invocation.env.HOME).toBe("/home/node");
    invocation.release();
  });

  it("materializes inline credentials without forwarding them", async () => {
    // The macOS-Docker path: the raw OAuth JSON arrives in the environment,
    // gets written to a private runtime dir, and each invocation is seeded
    // from it. The credential itself must not continue into the child.
    vi.stubEnv("CLAUDE_CODE_CREDENTIALS_JSON", '{"token":"oauth-secret"}');
    const { createClaudeInvocation } = await import("@/lib/agent/claude-code");

    const invocation = createClaudeInvocation();
    const env = invocation.env;
    invocation.release();

    expect(env.CLAUDE_CODE_CREDENTIALS_JSON).toBeUndefined();
    expect(Object.values(env)).not.toContain('{"token":"oauth-secret"}');
    expect(
      readFileSync("/tmp/claude-runtime/.claude/.credentials.json", "utf8"),
    ).toBe('{"token":"oauth-secret"}');
  });
});

describe("claude-code invocation isolation", () => {
  function seedClaudeHome(credentials: string): string {
    const home = mkdtempSync(join(tmpdir(), "claude-home-"));
    const dir = join(home, ".claude");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, ".credentials.json"), credentials);
    return home;
  }

  it("gives every invocation its own config dir", async () => {
    // The CLI rewrites its config on startup: two concurrent turns sharing a
    // config dir corrupt each other and exit 1 with an empty stderr.
    vi.stubEnv("CLAUDE_HOME", seedClaudeHome('{"token":"a"}'));
    const { createClaudeInvocation } = await import("@/lib/agent/claude-code");

    const first = createClaudeInvocation();
    const second = createClaudeInvocation();
    const dirs = [first.env.CLAUDE_CONFIG_DIR, second.env.CLAUDE_CONFIG_DIR];

    expect(dirs[0]).toBeTruthy();
    expect(dirs[0]).not.toBe(dirs[1]);
    // Seeded with the shared credentials, so the CLI authenticates.
    expect(
      readFileSync(join(dirs[0] as string, ".credentials.json"), "utf8"),
    ).toBe('{"token":"a"}');

    first.release();
    second.release();
    expect(existsSync(dirs[0] as string)).toBe(false);
  });

  it("drops the Anthropic API key when OAuth credentials are present", async () => {
    // Otherwise an expired OAuth session silently falls back to API-key
    // billing and fails with "Credit balance is too low" instead of an auth
    // error the reader can act on.
    vi.stubEnv("CLAUDE_HOME", seedClaudeHome('{"token":"a"}'));
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-key");
    vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "auth-token");
    const { createClaudeInvocation } = await import("@/lib/agent/claude-code");

    const invocation = createClaudeInvocation();
    const env = invocation.env;
    invocation.release();

    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  });

  it("writes a refreshed token back to the shared credentials", async () => {
    const home = seedClaudeHome('{"token":"old"}');
    vi.stubEnv("CLAUDE_HOME", home);
    const { createClaudeInvocation } = await import("@/lib/agent/claude-code");

    const invocation = createClaudeInvocation();
    // Stand in for the CLI refreshing the OAuth token mid-turn.
    writeFileSync(
      join(invocation.env.CLAUDE_CONFIG_DIR as string, ".credentials.json"),
      '{"token":"new"}',
    );
    invocation.release();

    expect(
      readFileSync(join(home, ".claude", ".credentials.json"), "utf8"),
    ).toBe('{"token":"new"}');
  });
});

describe("codex failure messages", () => {
  it("tells the reader to switch providers when codex is out of credits", async () => {
    const { codexFailureMessage } = await import("@/lib/agent/codex");

    const message = codexFailureMessage(
      1,
      "OpenAI Codex v0.144.6\n--------\n" +
        "ERROR: You've hit your usage limit. Try again at Aug 20th, 2026 2:09 PM.",
    );

    expect(message).toMatch(/usage limit/i);
    expect(message).toContain("Aug 20th, 2026 2:09 PM");
    expect(message).toMatch(/Settings/);
  });

  it("keeps the tail of stderr, where the real error lives", async () => {
    const { codexFailureMessage } = await import("@/lib/agent/codex");

    const message = codexFailureMessage(
      1,
      `${"banner ".repeat(200)}the actual failure`,
    );

    expect(message).toContain("the actual failure");
  });
});
