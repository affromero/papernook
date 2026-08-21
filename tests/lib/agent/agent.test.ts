import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    expect(inv.args).toContain("BatchMode=yes");
    expect(inv.args).toContain("StrictHostKeyChecking=yes");
    expect(inv.args.at(-2)).toBe("vps");
    expect(inv.args.at(-1)).toBe("'claude' '-p' 'hello world'");
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
      args: [
        "-o",
        "BatchMode=yes",
        "-o",
        "StrictHostKeyChecking=yes",
        "/a/x.png",
        "/b/y.png",
        "vps:/tmp/d/",
      ],
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
    const staged = await stageImagesOverSsh(["/local/crop.png"], "vps");

    expect(calls).toHaveLength(2);
    expect(calls[0].command).toBe("ssh"); // mkdir runs remotely
    expect(calls[0].args.join(" ")).toContain("mkdir");
    expect(calls[1].command).toBe("scp");
    expect(staged.paths).toHaveLength(1);
    expect(staged.paths[0]).toMatch(
      /^\/tmp\/papernook-attach-[0-9a-f]+\/crop\.png$/,
    );
    await staged.cleanup();
    expect(calls[2].args.join(" ")).toContain("rm");
    vi.doUnmock("node:child_process");
  });
});

describe("provider registry", () => {
  it("resolves the configured provider from AI_PROVIDER", async () => {
    vi.stubEnv("AI_PROVIDER", "claude-code");
    const { getProvider } = await import("@/lib/agent/registry");
    expect(getProvider().id).toBe("claude-code");
  });

  it("offers web access through every provider", async () => {
    const { getProvider, providerIds } = await import("@/lib/agent/registry");
    for (const id of providerIds()) {
      expect(getProvider(id).capabilities.web, id).toBe(true);
    }
  });

  it("allows CLI providers — the admin's Settings choice is the consent", async () => {
    vi.stubEnv("AI_PROVIDER", "codex");
    let registry = await import("@/lib/agent/registry");
    expect(registry.getProvider().id).toBe("codex");
    vi.resetModules();
    vi.stubEnv("AI_PROVIDER", "claude-code");
    registry = await import("@/lib/agent/registry");
    expect(registry.getProvider().id).toBe("claude-code");
  });

  it("throws a setup-pointing error when AI_PROVIDER is unset or invalid", async () => {
    vi.stubEnv("AI_PROVIDER", "");
    const { configuredProviderId } = await import("@/lib/agent/registry");
    expect(() => configuredProviderId()).toThrow(/AI_PROVIDER/);
    vi.stubEnv("AI_PROVIDER", "gemini");
    expect(() => configuredProviderId()).toThrow(/AI_PROVIDER/);
  });

  it("hasConfiguredProvider reports the no-AI mode without throwing", async () => {
    vi.stubEnv("AI_PROVIDER", "");
    const { hasConfiguredProvider } = await import("@/lib/agent/registry");
    expect(hasConfiguredProvider()).toBe(false);
    vi.stubEnv("AI_PROVIDER", "gemini");
    expect(hasConfiguredProvider()).toBe(false);
    vi.stubEnv("AI_PROVIDER", "anthropic");
    expect(hasConfiguredProvider()).toBe(true);
  });

  it("API providers report availability from env keys without spawning", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    const { isProviderAvailable } = await import("@/lib/agent/registry");
    expect(await isProviderAvailable("anthropic")).toBe(false);
    expect(await isProviderAvailable("openai")).toBe(true);
  });

  it("auto-detects Codex first, then Claude Code, without silent fallback", async () => {
    let codexReady = true;
    vi.doMock("node:child_process", () => ({
      spawn: (command: string) => ({
        kill: vi.fn(),
        on: (event: string, callback: (code?: number) => void) => {
          if (event === "close") {
            const ready =
              command === "codex" ? codexReady : command === "claude";
            setImmediate(() => callback(ready ? 0 : 1));
          }
        },
      }),
    }));
    const { detectLocalCliProvider } = await import("@/lib/agent/registry");

    expect(await detectLocalCliProvider()).toBe("codex");
    codexReady = false;
    expect(await detectLocalCliProvider()).toBe("claude-code");
    vi.doUnmock("node:child_process");
  });

  it("does not call an installed but unauthenticated CLI ready", async () => {
    vi.doMock("node:child_process", () => ({
      spawn: (_command: string, args: string[]) => ({
        kill: vi.fn(),
        on: (event: string, callback: (code?: number) => void) => {
          if (event === "close") {
            setImmediate(() => callback(args.includes("--version") ? 0 : 1));
          }
        },
      }),
    }));
    const { providerStatus } = await import("@/lib/agent/registry");

    expect(await providerStatus("codex")).toBe("not_authenticated");
    vi.doUnmock("node:child_process");
  });

  it("checks Claude readiness with the same credential environment as turns", async () => {
    // A real credentials file: an isolated config dir is only created when
    // there is a login to seed it with, because an empty one authenticates as
    // nobody. Without this the probe would fall back to the ambient config.
    const claudeHome = mkdtempSync(join(tmpdir(), "papernook-claude-home-"));
    mkdirSync(join(claudeHome, ".claude"), { recursive: true });
    writeFileSync(
      join(claudeHome, ".claude", ".credentials.json"),
      '{"claudeAiOauth":{"refreshTokenExpiresAt":9999999999999}}',
    );
    vi.stubEnv("CLAUDE_HOME", claudeHome);
    vi.stubEnv("CLAUDECODE", "nested-session");
    const configDirs: Array<string | undefined> = [];
    vi.doMock("node:child_process", () => ({
      spawn: (
        _command: string,
        _args: string[],
        options: { env?: NodeJS.ProcessEnv },
      ) => {
        configDirs.push(options.env?.CLAUDE_CONFIG_DIR);
        const hasUsableEnv =
          Boolean(options.env?.CLAUDE_CONFIG_DIR) &&
          options.env?.CLAUDECODE === undefined;
        return {
          kill: vi.fn(),
          on: (event: string, callback: (code?: number) => void) => {
            if (event === "close") {
              setImmediate(() => callback(hasUsableEnv ? 0 : 1));
            }
          },
        };
      },
    }));
    const { providerStatus } = await import("@/lib/agent/registry");

    expect(await providerStatus("claude-code")).toBe("ready");
    // One isolated config dir for the whole probe, seeded from CLAUDE_HOME —
    // the same shape a real turn gets, so readiness cannot pass while turns
    // fail (or corrupt a concurrent turn's config).
    expect(configDirs).toHaveLength(2);
    expect(configDirs[0]).toBe(configDirs[1]);
    vi.doUnmock("node:child_process");
  });

  it("probes local and custom OpenAI endpoints instead of requiring keys", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "papernook-probe-"));
    vi.stubEnv("PAPERNOOK_DATA_DIR", tmp);
    vi.stubEnv("OLLAMA_HOST", "http://models.test:11434/v1/");
    vi.stubEnv("OPENAI_BASE_URL", "http://gateway.test/v1");
    vi.stubEnv("OPENAI_API_KEY", "");
    const cfg = await import("@/lib/agent/config");
    cfg.setAgentModel("qwen3:4b");
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        urls.push(String(input));
        return new Response("{}", { status: 200 });
      }),
    );
    const { providerStatus } = await import("@/lib/agent/registry");

    expect(await providerStatus("ollama")).toBe("ready");
    expect(await providerStatus("openai")).toBe("ready");
    expect(urls).toEqual([
      "http://models.test:11434/api/tags",
      "http://gateway.test/v1/models",
    ]);
    vi.unstubAllGlobals();
  });

  it("reports an unreachable local endpoint without falling back", async () => {
    vi.stubEnv("VLLM_BASE_URL", "http://models.test:8000");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new Error("down"))),
    );
    const { providerStatus } = await import("@/lib/agent/registry");
    expect(await providerStatus("vllm")).toBe("unreachable");
    vi.unstubAllGlobals();
  });

  it("does not report a reachable local endpoint as usable without a model", async () => {
    vi.stubEnv("LLAMACPP_BASE_URL", "http://models.test:8080");
    vi.stubEnv("LLAMACPP_MODEL", "");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 200 })),
    );
    const { providerStatus } = await import("@/lib/agent/registry");
    expect(await providerStatus("llamacpp")).toBe("no_model");
    vi.unstubAllGlobals();
  });
});

describe("claude-code argv (mocked spawn boundary)", () => {
  interface SpawnCall {
    command: string;
    args: string[];
    stdin: string[];
  }

  function mockSpawn(
    calls: SpawnCall[],
    stdout = "answer",
    stderr = "",
    exitCode = 0,
  ) {
    vi.doMock("node:child_process", () => ({
      spawn: (command: string, args: string[]) => {
        const call: SpawnCall = { command, args, stdin: [] };
        calls.push(call);
        return {
          stdout: {
            on: (event: string, cb: (chunk: Buffer) => void) => {
              if (event === "data") setImmediate(() => cb(Buffer.from(stdout)));
            },
            // streamClaudeCode consumes stdout with `for await`.
            [Symbol.asyncIterator]: async function* () {
              yield Buffer.from(stdout);
            },
          },
          stderr: {
            on: (event: string, cb: (chunk: Buffer) => void) => {
              if (event === "data" && stderr)
                setImmediate(() => cb(Buffer.from(stderr)));
            },
          },
          stdin: {
            write: (data: string) => call.stdin.push(data),
            end: vi.fn(),
          },
          on: (event: string, cb: (code?: number) => void) => {
            if (event === "close")
              setImmediate(() => setImmediate(() => cb(exitCode)));
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
    expect(calls[0].args).toContain("--safe-mode");
    expect(calls[0].args).toContain("--tools");
    expect(calls[0].args[calls[0].args.indexOf("--tools") + 1]).toBe("");
    expect(calls[0].args[calls[0].args.indexOf("--permission-mode") + 1]).toBe(
      "dontAsk",
    );
    expect(calls[0].args).not.toContain("--allowedTools");
    expect(calls[0].stdin.join("")).toBe("explain section 3");
    vi.doUnmock("node:child_process");
  });

  it("passes the configured thinking effort to both CLI providers", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "papernook-effort-"));
    vi.stubEnv("PAPERNOOK_DATA_DIR", tmp);
    const calls: SpawnCall[] = [];
    mockSpawn(calls);
    const cfg = await import("@/lib/agent/config");

    cfg.updateAgentConfig({ provider: "claude-code", effort: "high" });
    const { executeClaudeCode } = await import("@/lib/agent/claude-code");
    await executeClaudeCode({ system: "", prompt: "analyze" });
    expect(calls[0].args).toContain("--effort");
    expect(calls[0].args[calls[0].args.indexOf("--effort") + 1]).toBe("high");

    cfg.updateAgentConfig({ provider: "codex", effort: "xhigh" });
    const { executeCodex } = await import("@/lib/agent/codex");
    await executeCodex({ system: "", prompt: "analyze" });
    expect(calls[1].args).toContain('model_reasoning_effort="xhigh"');

    fs.rmSync(tmp, { recursive: true, force: true });
    vi.doUnmock("node:child_process");
  });

  it("enables Codex live search only for web-enabled turns", async () => {
    const calls: SpawnCall[] = [];
    mockSpawn(calls);
    const { executeCodex } = await import("@/lib/agent/codex");
    await executeCodex({ system: "", prompt: "local context" });
    await executeCodex({
      system: "",
      prompt: "find the implementation",
      allowWeb: true,
    });

    expect(calls[0].args).toContain('web_search="disabled"');
    expect(calls[1].args).toContain('web_search="live"');
    vi.doUnmock("node:child_process");
  });

  it("grants only the web tools when the turn allows web access", async () => {
    const calls: SpawnCall[] = [];
    mockSpawn(calls);
    const { executeClaudeCode } = await import("@/lib/agent/claude-code");
    await executeClaudeCode({
      system: "",
      prompt: "what follow-up work exists?",
      allowWeb: true,
    });
    expect(calls[0].args[calls[0].args.indexOf("--tools") + 1]).toBe(
      "WebSearch,WebFetch",
    );
    expect(calls[0].args[calls[0].args.indexOf("--allowedTools") + 1]).toBe(
      "WebSearch,WebFetch",
    );
    expect(calls[0].args[calls[0].args.indexOf("--permission-mode") + 1]).toBe(
      "dontAsk",
    );
    vi.doUnmock("node:child_process");
  });

  it("sends images as base64 stream-json stdin without granting tools", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "papernook-vision-"));
    const crop = path.join(dir, "crop.png");
    fs.writeFileSync(crop, Buffer.from("89504e470d0a1a0a", "hex"));

    const calls: SpawnCall[] = [];
    const events = `${JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "a red square" }] },
    })}\n${JSON.stringify({ type: "result", result: "a red square" })}\n`;
    mockSpawn(calls, events);
    const { executeClaudeCode } = await import("@/lib/agent/claude-code");
    const result = await executeClaudeCode({
      system: "be brief",
      prompt: "explain this figure",
      images: [crop],
    });
    expect(result).toBe("a red square");

    const args = calls[0].args;
    expect(args[args.indexOf("--input-format") + 1]).toBe("stream-json");
    expect(args[args.indexOf("--output-format") + 1]).toBe("stream-json");
    // The security invariant: images must never widen the tool grant.
    expect(args[args.indexOf("--tools") + 1]).toBe("");
    expect(args).not.toContain("--allowedTools");

    const stdin = calls[0].stdin.join("");
    expect(stdin.endsWith("\n")).toBe(true);
    const message = JSON.parse(stdin) as {
      type: string;
      message: { role: string; content: unknown[] };
    };
    expect(message.type).toBe("user");
    expect(message.message.content[0]).toEqual({
      type: "image",
      source: {
        type: "base64",
        media_type: "image/png",
        data: fs.readFileSync(crop).toString("base64"),
      },
    });
    expect(message.message.content[1]).toEqual({
      type: "text",
      text: "explain this figure",
    });
    fs.rmSync(dir, { recursive: true, force: true });
    vi.doUnmock("node:child_process");
  });

  it("yields every assistant event when the stream has no deltas", async () => {
    const calls: SpawnCall[] = [];
    const events = `${JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "first " }] },
    })}\n${JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "second" }] },
    })}\n${JSON.stringify({ type: "result", result: "first second" })}\n`;
    mockSpawn(calls, events);
    const { streamClaudeCode } = await import("@/lib/agent/claude-code");
    const chunks: string[] = [];
    for await (const chunk of streamClaudeCode({ system: "", prompt: "hi" })) {
      chunks.push(chunk);
    }
    // Both assistant events stream; the result must not repeat the reply.
    expect(chunks).toEqual(["first ", "second"]);
    // Streaming must request live deltas, or long replies sit silent until
    // the end and idle proxies drop the connection.
    expect(calls[0].args).toContain("--include-partial-messages");
    vi.doUnmock("node:child_process");
  });

  it("reports bounded multiline output from a failed Claude process", async () => {
    const calls: SpawnCall[] = [];
    mockSpawn(
      calls,
      "partial response\nwith context",
      `\u001b[31mprovider error\u001b[0m\n${"detail".repeat(1_000)}`,
      1,
    );
    const { executeClaudeCode } = await import("@/lib/agent/claude-code");

    const failure = executeClaudeCode({
      system: "",
      prompt: "analyze this paper",
    });
    await expect(failure).rejects.toThrow(/claude-code: exited with code 1/);
    await expect(failure).rejects.toThrow(/\[stderr\]\nprovider error/);
    await expect(failure).rejects.toThrow(
      /\[stdout\]\npartial response\nwith context/,
    );
    await expect(failure).rejects.not.toThrow(/\u001b/);
    await expect(failure).rejects.toThrow(/output omitted/);
    await failure.catch((error: Error) => {
      expect(error.message.length).toBeLessThanOrEqual(4_050);
    });
    vi.doUnmock("node:child_process");
  });
});

describe("model configuration", () => {
  it("the config file is the only model source; clearing falls back to the provider default", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "papernook-model-"));
    vi.stubEnv("PAPERNOOK_DATA_DIR", tmp);
    // Per-provider *_MODEL env vars are intentionally gone.
    vi.stubEnv("CLAUDE_CODE_MODEL", "sonnet");
    const cfg = await import("@/lib/agent/config");
    expect(cfg.configuredModel()).toBeUndefined(); // env is ignored
    cfg.setAgentModel("opus");
    expect(cfg.configuredModel()).toBe("opus"); // file wins
    cfg.updateAgentConfig({ effort: "high" });
    expect(cfg.configuredEffort()).toBe("high");
    cfg.setAgentModel(null);
    expect(cfg.configuredModel()).toBeUndefined(); // provider default
    expect(cfg.configuredEffort()).toBeUndefined(); // model change clears effort
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("every provider has suggestions", async () => {
    const cfg = await import("@/lib/agent/config");
    expect(cfg.modelSuggestions("claude-code")).toEqual([
      "fable",
      "opus",
      "sonnet",
      "haiku",
    ]);
    for (const p of ["codex", "anthropic", "openai", "ollama"] as const) {
      expect(cfg.modelSuggestions(p).length).toBeGreaterThan(0);
    }
    expect(cfg.modelSuggestions("llamacpp")).toEqual([]);
    expect(cfg.modelSuggestions("vllm")).toEqual([]);
  });

  it("offers Claude Code aliases without redundant pinned model ids", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-test");
    const { listOfferedModels } = await import("@/lib/agent/models");
    await expect(listOfferedModels("claude-code")).resolves.toEqual({
      models: ["fable", "opus", "sonnet", "haiku"],
      live: false,
      effortOptions: ["low", "medium", "high", "xhigh", "max"],
      defaultEffort: null,
    });
  });

  it("discovers picker-visible Codex models through app-server over SSH", async () => {
    vi.stubEnv("CODEX_SSH_HOST", "agent-host");
    const calls: Array<{
      command: string;
      args: string[];
      messages: unknown[];
    }> = [];
    vi.doMock("node:child_process", () => ({
      spawn: (command: string, args: string[]) => {
        let stdoutData: ((chunk: Buffer) => void) | undefined;
        let close: ((code: number) => void) | undefined;
        const call = { command, args, messages: [] as unknown[] };
        calls.push(call);
        return {
          stdout: {
            on: (event: string, callback: (chunk: Buffer) => void) => {
              if (event === "data") stdoutData = callback;
            },
          },
          stderr: { on: vi.fn() },
          stdin: {
            write: (data: string) => {
              const message = JSON.parse(data) as {
                id?: number;
                method?: string;
                params?: { cursor?: string };
              };
              call.messages.push(message);
              if (message.id === 0) {
                setImmediate(() =>
                  stdoutData?.(Buffer.from('{"id":0,"result":{}}\n')),
                );
              } else if (message.method === "model/list") {
                const result = message.params?.cursor
                  ? {
                      data: [{ model: "gpt-5.6-terra", hidden: false }],
                      nextCursor: null,
                    }
                  : {
                      data: [
                        {
                          model: "gpt-5.6-sol",
                          hidden: false,
                          isDefault: true,
                          defaultReasoningEffort: "low",
                          supportedReasoningEfforts: [
                            { reasoningEffort: "low" },
                            { reasoningEffort: "high" },
                            { reasoningEffort: "future-value" },
                          ],
                        },
                        { model: "internal-model", hidden: true },
                      ],
                      nextCursor: "page-2",
                    };
                setImmediate(() =>
                  stdoutData?.(
                    Buffer.from(
                      `${JSON.stringify({ id: message.id, result })}\n`,
                    ),
                  ),
                );
              }
            },
            end: vi.fn(),
          },
          kill: () => setImmediate(() => close?.(0)),
          on: (event: string, callback: (code: number) => void) => {
            if (event === "close") close = callback;
          },
        };
      },
    }));

    const { listOfferedModels } = await import("@/lib/agent/models");
    await expect(listOfferedModels("codex")).resolves.toEqual({
      models: ["gpt-5.6-sol", "gpt-5.6-terra"],
      live: true,
      effortOptions: ["low", "high"],
      defaultEffort: "low",
    });
    expect(calls[0].command).toBe("ssh");
    expect(calls[0].args.at(-1)).toBe("'codex' 'app-server'");
    expect(calls[0].messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ method: "initialize", id: 0 }),
        expect.objectContaining({ method: "initialized" }),
        expect.objectContaining({
          method: "model/list",
          params: expect.objectContaining({ includeHidden: false }),
        }),
      ]),
    );
    vi.doUnmock("node:child_process");
  });

  it("falls back to current Codex suggestions when discovery fails", async () => {
    vi.doMock("node:child_process", () => ({
      spawn: () => ({
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
        stdin: { write: vi.fn(), end: vi.fn() },
        kill: vi.fn(),
        on: (event: string, callback: (error: Error) => void) => {
          if (event === "error")
            setImmediate(() => callback(new Error("not installed")));
        },
      }),
    }));

    const { listOfferedModels } = await import("@/lib/agent/models");
    await expect(listOfferedModels("codex")).resolves.toEqual({
      models: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"],
      live: false,
      effortOptions: ["low", "medium", "high", "xhigh", "max", "ultra"],
      defaultEffort: null,
    });
    vi.doUnmock("node:child_process");
  });

  it("uses stored endpoint then env then local default", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "papernook-url-"));
    vi.stubEnv("PAPERNOOK_DATA_DIR", tmp);
    vi.stubEnv("OLLAMA_HOST", "http://env.test:11434");
    const cfg = await import("@/lib/agent/config");

    expect(cfg.configuredBaseUrl("ollama")).toBe("http://env.test:11434");
    cfg.updateAgentConfig({
      provider: "ollama",
      model: "qwen3:4b",
      baseUrl: "http://stored.test:11434",
    });
    expect(cfg.configuredBaseUrl("ollama")).toBe("http://stored.test:11434");
    cfg.setAgentProvider("vllm");
    expect(cfg.configuredModel()).toBeUndefined();
    expect(cfg.storedBaseUrl("vllm")).toBeUndefined();
    vi.stubEnv("VLLM_BASE_URL", "");
    expect(cfg.configuredBaseUrl("vllm")).toBe("http://localhost:8000");
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

describe("provider override", () => {
  it("defaults web access on and preserves an opt-out across provider switches", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "papernook-prov-"));
    vi.stubEnv("PAPERNOOK_DATA_DIR", tmp);
    vi.stubEnv("AI_PROVIDER", "claude-code");
    const cfg = await import("@/lib/agent/config");
    const { configuredProviderId } = await import("@/lib/agent/registry");
    expect(configuredProviderId()).toBe("claude-code");
    expect(cfg.webAccessEnabled()).toBe(true);
    cfg.setAgentModel("opus");
    cfg.updateAgentConfig({ webAccess: false });
    expect(cfg.webAccessEnabled()).toBe(false);
    cfg.setAgentProvider("codex");
    expect(configuredProviderId()).toBe("codex");
    expect(cfg.configuredModel()).toBeUndefined(); // model cleared
    expect(cfg.webAccessEnabled()).toBe(false);
    cfg.setAgentProvider(null);
    expect(configuredProviderId()).toBe("claude-code"); // env again
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

describe("OpenAI-compatible local providers", () => {
  it("canonicalizes endpoint URLs without duplicating /v1", async () => {
    const { ensureV1Suffix } = await import("@/lib/agent/local");
    expect(ensureV1Suffix("http://localhost:11434")).toBe(
      "http://localhost:11434/v1",
    );
    expect(ensureV1Suffix("http://localhost:11434/v1/")).toBe(
      "http://localhost:11434/v1",
    );
  });

  it("uses the selected local model, endpoint, JSON mode, and no API key", async () => {
    const clients: { apiKey?: string; baseURL?: string }[] = [];
    const requests: unknown[] = [];
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "papernook-vllm-"));
    vi.stubEnv("PAPERNOOK_DATA_DIR", tmp);
    vi.stubEnv("VLLM_BASE_URL", "http://gpu.test:8000");
    const cfgModule = await import("@/lib/agent/config");
    cfgModule.setAgentModel("Qwen/Qwen3-8B");
    vi.doMock("openai", () => ({
      default: class {
        chat = {
          completions: {
            create: async (request: unknown) => {
              requests.push(request);
              return { choices: [{ message: { content: '{"ok":true}' } }] };
            },
          },
        };

        constructor(options: { apiKey?: string; baseURL?: string }) {
          clients.push(options);
        }
      },
    }));
    const { vllmProvider } = await import("@/lib/agent/api");
    const result = await vllmProvider.execute({
      system: "Return JSON.",
      prompt: "Analyze.",
      responseFormat: "json_object",
    });

    expect(result).toBe('{"ok":true}');
    expect(clients).toEqual([
      { apiKey: "unused", baseURL: "http://gpu.test:8000/v1" },
    ]);
    expect(requests).toEqual([
      expect.objectContaining({
        model: "Qwen/Qwen3-8B",
        response_format: { type: "json_object" },
      }),
    ]);
    vi.doUnmock("openai");
  });

  it("discovers installed Ollama models from the native tags endpoint", async () => {
    vi.stubEnv("OLLAMA_HOST", "http://models.test:11434/v1");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          models: [{ name: "qwen3:4b" }, { name: "gemma3:4b" }],
        }),
      ),
    );
    const { listOfferedModels } = await import("@/lib/agent/models");
    await expect(listOfferedModels("ollama")).resolves.toEqual({
      models: ["qwen3:4b", "gemma3:4b"],
      live: true,
    });
    expect(fetch).toHaveBeenCalledWith(
      "http://models.test:11434/api/tags",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    vi.unstubAllGlobals();
  });
});
