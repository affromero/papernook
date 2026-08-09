import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configuredModel } from "./config";
import { buildAgentInvocation, getClaudeSshHost } from "./invocation";
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
 * filesystem-reading agent; when the admin opts a turn into web access the
 * only tools granted are WebSearch and WebFetch — never the filesystem.
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
  // Strip CLAUDECODE to prevent "cannot launch inside another session".
  const baseEnv = { ...process.env };
  delete baseEnv.CLAUDECODE;
  const home = ensureClaudeHome();
  return home ? { ...baseEnv, HOME: home } : baseEnv;
}

async function buildArgs(
  turn: AgentTurn,
  streaming: boolean,
): Promise<{ args: string[]; prompt: string }> {
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
  ];
  const model = configuredModel();
  if (model) args.push("--model", model);
  args.push("--output-format", streaming ? "stream-json" : "text");
  if (streaming) args.push("--verbose");
  if (turn.system) args.push("--system-prompt", turn.system);

  const prompt = turn.prompt;
  const images = turn.images ?? [];
  if (images.length > 0) {
    throw new Error(
      "claude-code image attachments are disabled because they require filesystem tools. Use an API provider for image chats.",
    );
  }
  return { args, prompt };
}

export async function executeClaudeCode(turn: AgentTurn): Promise<string> {
  const timeoutMs = turn.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const { args, prompt } = await buildArgs(turn, false);
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
    child.stdin.write(prompt);
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

function* textFromEvent(
  raw: StreamEvent,
  hasDeltas: boolean,
): Generator<string> {
  const event = raw.type === "stream_event" && raw.event ? raw.event : raw;
  if (event.type === "content_block_delta" && event.delta?.text) {
    yield event.delta.text;
  } else if (event.type === "result" && !hasDeltas) {
    if (typeof event.result === "string" && event.result) yield event.result;
  } else if (event.type === "assistant" && !hasDeltas) {
    const blocks = event.message?.content ?? event.content;
    if (Array.isArray(blocks)) {
      for (const block of blocks as { type?: string; text?: string }[]) {
        if (block.type === "text" && block.text) yield block.text;
      }
    }
  }
}

export async function* streamClaudeCode(
  turn: AgentTurn,
): AsyncGenerator<string> {
  const timeoutMs = turn.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const { args, prompt } = await buildArgs(turn, true);
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
  child.stdin.write(prompt);
  child.stdin.end();

  let buffer = "";
  let hasDeltas = false;
  try {
    for await (const chunk of child.stdout) {
      buffer += (chunk as Buffer).toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const raw = JSON.parse(line) as StreamEvent;
          for (const text of textFromEvent(raw, hasDeltas)) {
            hasDeltas = true;
            yield text;
          }
        } catch {
          continue; // partial line, not valid JSON
        }
      }
    }
    if (buffer.trim()) {
      try {
        const raw = JSON.parse(buffer) as StreamEvent;
        for (const text of textFromEvent(raw, hasDeltas)) {
          hasDeltas = true;
          yield text;
        }
      } catch {
        yield buffer.trim();
        hasDeltas = true;
      }
    }
    if (!hasDeltas) {
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
  capabilities: { web: true, vision: false },
  execute: executeClaudeCode,
  stream: streamClaudeCode,
};
