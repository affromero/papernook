import { describe, it, expect, beforeEach, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
});

describe("invocation building", () => {
  it("runs the CLI directly when no SSH host is set", async () => {
    const { buildAgentInvocation } = await import("@/lib/agent/invocation");
    const inv = buildAgentInvocation("claude", [
      "-p",
      "--output-format",
      "text",
    ]);
    expect(inv).toEqual({
      command: "claude",
      args: ["-p", "--output-format", "text"],
    });
  });

  it("wraps the argv in ssh BatchMode when a host is set", async () => {
    const { buildAgentInvocation } = await import("@/lib/agent/invocation");
    const inv = buildAgentInvocation("claude", ["-p", "hello world"], "vps");
    expect(inv.command).toBe("ssh");
    expect(inv.args.slice(0, 3)).toEqual(["-o", "BatchMode=yes", "-T"]);
    expect(inv.args[3]).toBe("vps");
    expect(inv.args[4]).toBe("'claude' '-p' 'hello world'");
  });

  it("shellQuote survives embedded single quotes", async () => {
    const { shellQuote } = await import("@/lib/agent/invocation");
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
  });

  it("builds scp with BatchMode targeting the remote dir", async () => {
    const { buildScpInvocation } = await import("@/lib/agent/invocation");
    const inv = buildScpInvocation(["/a/x.png", "/b/y.png"], "vps", "/tmp/d");
    expect(inv).toEqual({
      command: "scp",
      args: ["-o", "BatchMode=yes", "/a/x.png", "/b/y.png", "vps:/tmp/d/"],
    });
  });
});

describe("attachment routing", () => {
  it("maps extensions to media types with a png fallback", async () => {
    const { imageMediaType } = await import("@/lib/agent/attachments");
    expect(imageMediaType("/x/crop.jpg")).toBe("image/jpeg");
    expect(imageMediaType("/x/crop.webp")).toBe("image/webp");
    expect(imageMediaType("/x/unknown.bin")).toBe("image/png");
  });

  it("builds a preamble listing every attached path", async () => {
    const { imagePromptPreamble } = await import("@/lib/agent/attachments");
    const preamble = imagePromptPreamble(["/tmp/a.png", "/tmp/b.png"]);
    expect(preamble).toContain("- /tmp/a.png");
    expect(preamble).toContain("- /tmp/b.png");
    expect(imagePromptPreamble([])).toBe("");
  });

  it("stages images over SSH via mkdir + scp and returns remote paths", async () => {
    const calls: { command: string; args: string[] }[] = [];
    vi.doMock("node:child_process", () => ({
      spawn: (command: string, args: string[]) => {
        calls.push({ command, args });
        return {
          stdio: [],
          stderr: { on: vi.fn() },
          on: (event: string, cb: (code?: number) => void) => {
            if (event === "close") setImmediate(() => cb(0));
          },
        };
      },
    }));
    const { stageImagesOverSsh } = await import("@/lib/agent/attachments");
    const remote = await stageImagesOverSsh(["/local/crop.png"], "vps");

    expect(calls).toHaveLength(2);
    expect(calls[0].command).toBe("ssh"); // mkdir runs remotely
    expect(calls[0].args.join(" ")).toContain("mkdir");
    expect(calls[1].command).toBe("scp");
    expect(remote).toHaveLength(1);
    expect(remote[0]).toMatch(/^\/tmp\/papernook-attach-[0-9a-f]+\/crop\.png$/);
    vi.doUnmock("node:child_process");
  });
});

describe("provider registry", () => {
  it("resolves the configured provider from AI_PROVIDER", async () => {
    vi.stubEnv("AI_PROVIDER", "claude-code");
    const { getProvider } = await import("@/lib/agent/registry");
    expect(getProvider().id).toBe("claude-code");
  });

  it("throws a setup-pointing error when AI_PROVIDER is unset or invalid", async () => {
    vi.stubEnv("AI_PROVIDER", "");
    const { configuredProviderId } = await import("@/lib/agent/registry");
    expect(() => configuredProviderId()).toThrow(/AI_PROVIDER/);
    vi.stubEnv("AI_PROVIDER", "gemini");
    expect(() => configuredProviderId()).toThrow(/AI_PROVIDER/);
  });

  it("API providers report availability from env keys without spawning", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    const { isProviderAvailable } = await import("@/lib/agent/registry");
    expect(await isProviderAvailable("anthropic")).toBe(false);
    expect(await isProviderAvailable("openai")).toBe(true);
  });
});

describe("claude-code argv (mocked spawn boundary)", () => {
  interface SpawnCall {
    command: string;
    args: string[];
    stdin: string[];
  }

  function mockSpawn(calls: SpawnCall[], stdout = "answer") {
    vi.doMock("node:child_process", () => ({
      spawn: (command: string, args: string[]) => {
        const call: SpawnCall = { command, args, stdin: [] };
        calls.push(call);
        return {
          stdout: {
            on: (event: string, cb: (chunk: Buffer) => void) => {
              if (event === "data") setImmediate(() => cb(Buffer.from(stdout)));
            },
          },
          stderr: { on: vi.fn() },
          stdin: {
            write: (data: string) => call.stdin.push(data),
            end: vi.fn(),
          },
          on: (event: string, cb: (code?: number) => void) => {
            if (event === "close")
              setImmediate(() => setImmediate(() => cb(0)));
          },
          kill: vi.fn(),
        };
      },
    }));
  }

  it("pipes the prompt via stdin and passes the system prompt as an arg", async () => {
    const calls: SpawnCall[] = [];
    mockSpawn(calls);
    const { executeClaudeCode } = await import("@/lib/agent/claude-code");
    const result = await executeClaudeCode({
      system: "be brief",
      prompt: "explain section 3",
    });
    expect(result).toBe("answer");
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe("claude");
    expect(calls[0].args).toContain("--system-prompt");
    expect(calls[0].args).toContain("be brief");
    expect(calls[0].stdin.join("")).toBe("explain section 3");
    vi.doUnmock("node:child_process");
  });

  it("with images: allows the Read tool and prepends the path preamble", async () => {
    const calls: SpawnCall[] = [];
    mockSpawn(calls);
    const { executeClaudeCode } = await import("@/lib/agent/claude-code");
    await executeClaudeCode({
      system: "",
      prompt: "explain this figure",
      images: ["/data/library/nlp/attention/crops/1.png"],
    });
    const call = calls[0];
    const allowedIdx = call.args.indexOf("--allowedTools");
    expect(allowedIdx).toBeGreaterThan(-1);
    expect(call.args[allowedIdx + 1]).toBe("Read");
    const prompt = call.stdin.join("");
    expect(prompt).toContain("/data/library/nlp/attention/crops/1.png");
    expect(prompt).toContain("explain this figure");
    vi.doUnmock("node:child_process");
  });
});

describe("model configuration", () => {
  it("file beats env beats default, and clearing falls back", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "papernook-model-"));
    vi.stubEnv("PAPERNOOK_DATA_DIR", tmp);
    vi.stubEnv("CLAUDE_CODE_MODEL", "sonnet");
    const cfg = await import("@/lib/agent/config");
    expect(cfg.configuredModel("claude-code")).toBe("sonnet"); // env
    cfg.setAgentModel("opus");
    expect(cfg.configuredModel("claude-code")).toBe("opus"); // file wins
    cfg.setAgentModel(null);
    expect(cfg.configuredModel("claude-code")).toBe("sonnet"); // env again
    vi.stubEnv("CLAUDE_CODE_MODEL", "");
    expect(cfg.configuredModel("claude-code")).toBeUndefined(); // default
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("every provider has suggestions", async () => {
    const cfg = await import("@/lib/agent/config");
    for (const p of ["claude-code", "codex", "anthropic", "openai"] as const) {
      expect(cfg.modelSuggestions(p).length).toBeGreaterThan(0);
    }
  });
});
