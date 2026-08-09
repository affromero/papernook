import { spawn } from "node:child_process";
import { configuredModel } from "./config";
import { buildAgentInvocation, getCodexSshHost } from "./invocation";
import { stageImagesOverSsh, imagePromptPreamble } from "./attachments";
import {
  DEFAULT_TIMEOUT_MS,
  type AgentProvider,
  type AgentTurn,
} from "./types";

/**
 * Codex CLI provider (`codex exec`). Keyless: uses the CLI's own auth,
 * locally or over SSH (CODEX_SSH_HOST). Prompt via stdin; images via `-i`
 * locally, or scp + path preamble over SSH (codex -i needs local files).
 */

function buildBase(): string[] {
  const args = [
    "exec",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "-c",
    "mcp_servers={}",
    "-s",
    "read-only",
    "--skip-git-repo-check",
  ];
  const model = configuredModel();
  if (model) args.push("-m", model);
  return args;
}

async function prepare(
  turn: AgentTurn,
): Promise<{ args: string[]; prompt: string; cleanup?: () => Promise<void> }> {
  const args = buildBase();
  let cleanup: (() => Promise<void>) | undefined;
  let prompt = turn.system ? `${turn.system}\n\n${turn.prompt}` : turn.prompt;
  const images = turn.images ?? [];
  if (images.length > 0) {
    const sshHost = getCodexSshHost();
    if (sshHost) {
      const staged = await stageImagesOverSsh(images, sshHost);
      cleanup = staged.cleanup;
      prompt = imagePromptPreamble(staged.paths) + prompt;
    } else {
      for (const image of images) args.push("-i", image);
    }
  }
  args.push("-"); // read the prompt from stdin
  return { args, prompt, cleanup };
}

function runCodex(
  args: string[],
  prompt: string,
  timeoutMs: number,
  onChunk?: (text: string) => void,
): Promise<string> {
  const { command, args: spawnArgs } = buildAgentInvocation(
    "codex",
    args,
    getCodexSshHost(),
  );
  return new Promise((resolve, reject) => {
    const child = spawn(command, spawnArgs, {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`codex: timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      onChunk?.(text);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(
          new Error(`codex: exited with code ${code}: ${stderr.slice(0, 500)}`),
        );
        return;
      }
      const content = stdout.trim();
      if (!content) {
        reject(
          new Error(
            `codex: no output produced. Buffer: ${stderr.trim().slice(0, 300) || "(empty)"}`,
          ),
        );
        return;
      }
      resolve(content);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(
        new Error(
          `codex: failed to spawn: ${err.message}. Is the 'codex' CLI installed?`,
        ),
      );
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

export async function executeCodex(turn: AgentTurn): Promise<string> {
  const { args, prompt, cleanup } = await prepare(turn);
  try {
    return await runCodex(args, prompt, turn.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  } finally {
    await cleanup?.();
  }
}

export async function* streamCodex(turn: AgentTurn): AsyncGenerator<string> {
  // codex exec writes progressively to stdout; forward chunks as they arrive.
  const { args, prompt, cleanup } = await prepare(turn);
  const chunks: string[] = [];
  let notify: (() => void) | null = null;
  let done = false;
  let failure: Error | null = null;

  const finished = runCodex(
    args,
    prompt,
    turn.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    (text) => {
      chunks.push(text);
      notify?.();
    },
  )
    .catch((err: Error) => {
      failure = err;
    })
    .finally(() => {
      done = true;
      notify?.();
    });

  try {
    while (!done || chunks.length > 0) {
      if (chunks.length === 0) {
        await new Promise<void>((resolve) => {
          notify = resolve;
        });
        notify = null;
        continue;
      }
      yield chunks.shift() as string;
    }
    await finished;
    if (failure) throw failure;
  } finally {
    await cleanup?.();
  }
}

export const codexProvider: AgentProvider = {
  id: "codex",
  // The read-only sandbox has no network, so allowWeb cannot be honored.
  capabilities: { web: false, vision: true },
  execute: executeCodex,
  stream: streamCodex,
};
