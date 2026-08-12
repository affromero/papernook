import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readImageBase64 } from "./attachments";
import { configuredEffort, configuredModel } from "./config";
import {
  buildAgentInvocation,
  getClaudeSshHost,
  minimalAgentEnvironment,
} from "./invocation";
import {
  DEFAULT_TIMEOUT_MS,
  type AgentProvider,
  type AgentTurn,
} from "./types";

/**
 * Claude Code CLI provider (`claude -p`).
 * Keyless: uses whatever auth the CLI has, locally or over SSH
 * (CLAUDE_CODE_SSH_HOST). Prompt is piped via stdin to avoid ARG_MAX.
 * Project settings, MCP servers, and persistence are disabled, and tools
 * default to none so paper content cannot turn the CLI into a
 * filesystem-reading agent; when web access is enabled for a turn, the
 * only tools granted are WebSearch and WebFetch — never the filesystem.
 * Image attachments travel as base64 content blocks inside a stream-json
 * stdin message (which requires stream-json output), so vision needs no
 * tools and no files on the agent host — the same transport works locally
 * and over SSH.
 */

/**
 * Prepare a writable HOME for the claude subprocess. Volume-mounted host
 * credentials are often root-owned and read-only; the CLI needs a writable
 * ~/.claude for session data. Priority: CLAUDE_CODE_CREDENTIALS_JSON →
 * CLAUDE_HOME → process HOME. Cached for the container lifetime.
 */
let claudeHome: string | null | undefined;
const MAX_FAILURE_DIAGNOSTIC_CHARS = 4_000;

function cleanDiagnostic(value: string): string {
  return value
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .trim();
}

function failureDiagnostic(stdout: string, stderr: string): string {
  const sections: string[] = [];
  const cleanStderr = cleanDiagnostic(stderr);
  const cleanStdout = cleanDiagnostic(stdout);
  if (cleanStderr) sections.push(`[stderr]\n${cleanStderr}`);
  if (cleanStdout) sections.push(`[stdout]\n${cleanStdout}`);
  const diagnostic = sections.join("\n\n") || "(no stdout or stderr)";
  if (diagnostic.length <= MAX_FAILURE_DIAGNOSTIC_CHARS) return diagnostic;
  const marker = "\n\n[… earlier/middle output omitted …]\n\n";
  const remaining = MAX_FAILURE_DIAGNOSTIC_CHARS - marker.length;
  const head = Math.ceil(remaining / 2);
  const tail = Math.floor(remaining / 2);
  return `${diagnostic.slice(0, head)}${marker}${diagnostic.slice(-tail)}`;
}

function ensureClaudeHome(): string | undefined {
  if (claudeHome !== undefined) return claudeHome ?? undefined;
  const credsJson = process.env.CLAUDE_CODE_CREDENTIALS_JSON;
  if (credsJson) {
    try {
      const runtimeDir = "/tmp/claude-runtime";
      const claudeDir = join(runtimeDir, ".claude");
      mkdirSync(claudeDir, { recursive: true });
      writeFileSync(join(claudeDir, ".credentials.json"), credsJson, {
        mode: 0o600,
      });
      claudeHome = runtimeDir;
      return runtimeDir;
    } catch (err) {
      console.error("claude-code: failed to write credentials to /tmp", err);
    }
  }
  claudeHome = process.env.CLAUDE_HOME ?? null;
  return claudeHome ?? undefined;
}

/**
 * The process environment used by every local Claude CLI probe and turn.
 * Readiness must use this too, otherwise env-provided credentials work for
 * real prompts while Settings incorrectly reports that the CLI needs login.
 */
export function claudeCodeEnvironment(): NodeJS.ProcessEnv {
  // Allowlisted: the CLI's own namespace, never the app's other secrets.
  const baseEnv = minimalAgentEnvironment(["CLAUDE", "ANTHROPIC_"]);
  // Strip CLAUDECODE to prevent "cannot launch inside another session".
  delete baseEnv.CLAUDECODE;
  const home = ensureClaudeHome();
  return home ? { ...baseEnv, HOME: home } : baseEnv;
}

async function buildArgs(
  turn: AgentTurn,
  streaming: boolean,
): Promise<{ args: string[]; stdin: string }> {
  const args = [
    "-p",
    "--safe-mode",
    "--disable-slash-commands",
    "--no-session-persistence",
    "--strict-mcp-config",
    "--mcp-config",
    '{"mcpServers":{}}',
    "--tools",
    turn.allowWeb ? "WebSearch,WebFetch" : "",
    "--permission-mode",
    "dontAsk",
  ];
  if (turn.allowWeb) {
    // --tools exposes the pair, while --allowedTools pre-authorizes it.
    // Without both, print mode cannot show an approval prompt and Claude
    // receives a permission-denied tool result instead of searching.
    args.push("--allowedTools", "WebSearch,WebFetch");
  }
  const model = configuredModel();
  if (model) args.push("--model", model);
  const effort = configuredEffort();
  if (effort) args.push("--effort", effort);
  args.push("--output-format", streaming ? "stream-json" : "text");
  // --include-partial-messages makes the CLI emit content_block_delta events
  // as tokens arrive; without it the reply lands as one assistant event at
  // the very end, so a long answer streams nothing for minutes and proxies
  // (Cloudflare's 100s idle cutoff) kill the connection mid-chat.
  if (streaming) args.push("--verbose", "--include-partial-messages");
  if (turn.system) args.push("--system-prompt", turn.system);

  const images = turn.images ?? [];
  if (images.length === 0) return { args, stdin: turn.prompt };

  // Images ride inside a single stream-json user message so the CLI needs
  // no filesystem access — required by the security posture above.
  args.push("--input-format", "stream-json");
  const content: object[] = images.map((image) => {
    const { mediaType, data } = readImageBase64(image);
    return {
      type: "image",
      source: { type: "base64", media_type: mediaType, data },
    };
  });
  content.push({ type: "text", text: turn.prompt });
  const message = {
    type: "user",
    message: { role: "user", content },
  };
  return { args, stdin: `${JSON.stringify(message)}\n` };
}

export async function executeClaudeCode(turn: AgentTurn): Promise<string> {
  if (turn.images?.length || turn.maxOutputChars) {
    // stream-json input requires stream-json output; reuse the stream parser.
    let full = "";
    for await (const chunk of streamClaudeCode(turn)) full += chunk;
    return full;
  }
  const timeoutMs = turn.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const { args, stdin } = await buildArgs(turn, false);
  const { command, args: spawnArgs } = buildAgentInvocation(
    "claude",
    args,
    getClaudeSshHost(),
  );

  return new Promise((resolve, reject) => {
    const child = spawn(command, spawnArgs, {
      stdio: ["pipe", "pipe", "pipe"],
      env: claudeCodeEnvironment(),
    });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`claude-code: timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(
          new Error(
            `claude-code: exited with code ${code}\n${failureDiagnostic(stdout, stderr)}`,
          ),
        );
        return;
      }
      const content = stdout.trim();
      if (!content) {
        const detail = stderr.trim().slice(0, 300) || "(empty)";
        reject(new Error(`claude-code: no output produced. Buffer: ${detail}`));
        return;
      }
      resolve(content);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(
        new Error(
          `claude-code: failed to spawn: ${err.message}. Is the 'claude' CLI installed?`,
        ),
      );
    });
    child.stdin.write(stdin);
    child.stdin.end();
  });
}

interface StreamEvent {
  type?: string;
  event?: StreamEvent;
  delta?: { text?: string };
  result?: unknown;
  message?: { content?: unknown };
  content?: unknown;
}

/**
 * Which event kinds already produced text. Deltas outrank assistant events
 * (assistant messages repeat delta text); assistant events outrank the final
 * result (which repeats the full reply). Every assistant event yields — a
 * turn without deltas can carry text across several of them.
 */
interface StreamTextState {
  sawDelta: boolean;
  sawAssistant: boolean;
}

function* textFromEvent(
  raw: StreamEvent,
  state: StreamTextState,
): Generator<string> {
  const event = raw.type === "stream_event" && raw.event ? raw.event : raw;
  if (event.type === "content_block_delta" && event.delta?.text) {
    state.sawDelta = true;
    yield event.delta.text;
  } else if (event.type === "result" && !state.sawDelta) {
    if (state.sawAssistant) return;
    if (typeof event.result === "string" && event.result) yield event.result;
  } else if (event.type === "assistant" && !state.sawDelta) {
    const blocks = event.message?.content ?? event.content;
    if (Array.isArray(blocks)) {
      for (const block of blocks as { type?: string; text?: string }[]) {
        if (block.type === "text" && block.text) {
          state.sawAssistant = true;
          yield block.text;
        }
      }
    }
  }
}

export async function* streamClaudeCode(
  turn: AgentTurn,
): AsyncGenerator<string> {
  const timeoutMs = turn.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const { args, stdin } = await buildArgs(turn, true);
  const { command, args: spawnArgs } = buildAgentInvocation(
    "claude",
    args,
    getClaudeSshHost(),
  );
  const child = spawn(command, spawnArgs, {
    stdio: ["pipe", "pipe", "pipe"],
    env: claudeCodeEnvironment(),
  });
  const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);

  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  let exitCode: number | null = null;
  child.on("close", (code) => {
    exitCode = code;
  });
  child.stdin.write(stdin);
  child.stdin.end();

  let buffer = "";
  let produced = false;
  let outputChars = 0;
  const state: StreamTextState = { sawDelta: false, sawAssistant: false };
  try {
    for await (const chunk of child.stdout) {
      buffer += (chunk as Buffer).toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let raw: StreamEvent;
        try {
          raw = JSON.parse(line) as StreamEvent;
        } catch {
          continue; // partial line, not valid JSON
        }
        for (const text of textFromEvent(raw, state)) {
          outputChars += text.length;
          if (turn.maxOutputChars && outputChars > turn.maxOutputChars) {
            child.kill("SIGTERM");
            throw new Error("claude-code: output limit exceeded");
          }
          produced = true;
          yield text;
        }
      }
    }
    if (buffer.trim()) {
      let raw: StreamEvent | null = null;
      try {
        raw = JSON.parse(buffer) as StreamEvent;
      } catch {
        // Preserve a final plain-text fragment from unusual CLI output.
      }
      if (raw) {
        for (const text of textFromEvent(raw, state)) {
          outputChars += text.length;
          if (turn.maxOutputChars && outputChars > turn.maxOutputChars) {
            child.kill("SIGTERM");
            throw new Error("claude-code: output limit exceeded");
          }
          produced = true;
          yield text;
        }
      } else {
        yield buffer.trim();
        produced = true;
      }
    }
    if (!produced) {
      if (exitCode !== null && exitCode !== 0) {
        throw new Error(
          stderr.trim() || `claude-code exited with code ${exitCode}`,
        );
      }
      throw new Error(
        `claude-code: no output produced. Buffer: ${stderr.trim().slice(0, 300) || "(empty)"}`,
      );
    }
  } finally {
    clearTimeout(timer);
    child.kill("SIGTERM");
  }
}

export const claudeCodeProvider: AgentProvider = {
  id: "claude-code",
  capabilities: { web: true, vision: true, unboundedContext: true },
  execute: executeClaudeCode,
  stream: streamClaudeCode,
};
