import {
  ProcessRunner,
  ProcessExecutionError,
} from "thesidedoor-core/runtime/process";
import {
  CodexOutputDecoder,
  CliProtocolError,
  type CliOutputEvent,
} from "thesidedoor-core/runtime/cli";
import type { ExecutionObserver } from "thesidedoor-core/observability";
import { configuredEffort, configuredModel, readAgentConfig } from "./config";
import { observeAgentStream } from "./platform/observed-stream";
import {
  agentProcessRequest,
  getCodexSshHost,
  minimalAgentEnvironment,
} from "./invocation";
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
 *
 * `-s read-only` stops writes, not reads, and paper text steers this turn —
 * so the child is spawned with an allowlisted environment (CODEX_* only) and
 * never sees the app's secrets. It can still read files it has access to;
 * Settings warns about that.
 */

export function codexEnvironment(): NodeJS.ProcessEnv {
  return minimalAgentEnvironment(["CODEX_HOME", "CODEX_API_KEY"]);
}

function buildBase(
  turn: AgentTurn,
  config: ReturnType<typeof readAgentConfig>,
): string[] {
  const args = [
    "exec",
    "--json",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "-c",
    "mcp_servers={}",
    "-c",
    `web_search=${JSON.stringify(turn.allowWeb ? "live" : "disabled")}`,
    "-s",
    "read-only",
    "--skip-git-repo-check",
  ];
  const model = configuredModel(config);
  if (model) args.push("-m", model);
  const effort = configuredEffort(config);
  if (effort) {
    args.push("-c", `model_reasoning_effort=${JSON.stringify(effort)}`);
  }
  return args;
}

async function prepare(
  turn: AgentTurn,
  config: ReturnType<typeof readAgentConfig>,
  sshHost?: string,
): Promise<{ args: string[]; prompt: string; cleanup?: () => Promise<void> }> {
  const args = buildBase(turn, config);
  let cleanup: (() => Promise<void>) | undefined;
  let prompt = turn.system ? `${turn.system}\n\n${turn.prompt}` : turn.prompt;
  const images = turn.images ?? [];
  if (images.length > 0) {
    if (sshHost) {
      const staged = await stageImagesOverSsh(images, sshHost, {
        signal: turn.signal,
      });
      cleanup = staged.cleanup;
      prompt = imagePromptPreamble(staged.paths) + prompt;
    } else {
      for (const image of images) args.push("-i", image);
    }
  }
  args.push("-"); // read the prompt from stdin
  return { args, prompt, cleanup };
}

/**
 * Turn a raw codex exit into something the reader can act on. The CLI prints
 * a version banner and session header first, so the head of stderr is noise
 * and the real error — a usage limit, an expired login — is at the tail.
 */
export function codexFailureMessage(
  code: number | null,
  stderr: string,
): string {
  if (/rate.?limit|usage.?limit|too many requests|quota|429/i.test(stderr)) {
    const reset = stderr.match(/try again (?:at|in) ([^.\n]+)/i)?.[1];
    return `Codex has hit its usage limit${
      reset ? ` (available again ${reset.trim()})` : ""
    }. Switch to another AI provider in Settings, or try again later.`;
  }
  if (/unauthorized|authentication|not logged in|401/i.test(stderr)) {
    return "Codex is not authenticated. Re-connect it in Settings, or switch to another AI provider.";
  }
  return `codex: exited with code ${code}: ${stderr.trim().slice(-500)}`;
}

export async function executeCodex(turn: AgentTurn): Promise<string> {
  let text = "";
  for await (const chunk of streamCodex(turn)) text += chunk;
  return text.trim();
}

export function streamCodex(turn: AgentTurn): AsyncGenerator<string> {
  return observeAgentStream("codex", turn, {
    prepare() {
      const config = readAgentConfig();
      return {
        model: configuredModel(config),
        open(observer) {
          const signal = AbortSignal.any([
            observer.signal,
            AbortSignal.timeout(turn.timeoutMs ?? DEFAULT_TIMEOUT_MS),
          ]);
          return streamCodexRaw({ ...turn, signal }, config, observer);
        },
      };
    },
  });
}

async function* streamCodexRaw(
  turn: AgentTurn,
  config: ReturnType<typeof readAgentConfig>,
  observer: ExecutionObserver,
): AsyncGenerator<string> {
  turn.signal?.throwIfAborted();
  const sshHost = getCodexSshHost();
  const { args, prompt, cleanup } = await prepare(turn, config, sshHost);
  let stderr = "";
  let outputChars = 0;
  let content = false;
  const decoder = new CodexOutputDecoder();
  let decoderFinished = false;
  let failure = "";
  let primary: { error: unknown } | undefined;
  function* consume(events: Iterable<CliOutputEvent>): Generator<string> {
    for (const event of events) {
      if (event.type === "usage") observer.usage(event.usage);
      else if (event.type === "failure")
        failure = (failure + "\n" + event.message).slice(-4096);
      else {
        const text = event.text + "\n";
        outputChars += text.length;
        if (turn.maxOutputChars && outputChars > turn.maxOutputChars)
          throw new ProcessExecutionError("output_limit");
        content ||= Boolean(text.trim());
        yield text;
      }
    }
  }
  try {
    const runner = new ProcessRunner();
    for await (const chunk of runner.stream(
      agentProcessRequest({
        cli: "codex",
        args,
        sshHost,
        environment: codexEnvironment(),
        input: prompt,
        signal: turn.signal,
        timeoutMs: turn.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      }),
    )) {
      if (chunk.channel === "stderr") {
        stderr = (stderr + chunk.text).slice(-4096);
        continue;
      }
      yield* consume(decoder.push(chunk.text));
    }
    decoderFinished = true;
    yield* consume(decoder.finish());
    if (failure)
      throw new Error(codexFailureMessage(1, failure + "\n" + stderr));
    if (!content)
      throw new Error(
        `codex: no output produced. Buffer: ${stderr.trim().slice(0, 300) || "(empty)"}`,
      );
  } catch (error) {
    if (!decoderFinished) {
      decoderFinished = true;
      try {
        for (const event of decoder.finish(false)) {
          if (event.type === "usage") observer.usage(event.usage);
          else if (event.type === "failure")
            failure = (failure + "\n" + event.message).slice(-4096);
        }
      } catch {
        // Incomplete protocol output must not replace the transport failure.
      }
    }
    let reported = error;
    if (error instanceof ProcessExecutionError) {
      if (error.code === "exit_failed")
        reported = new Error(
          codexFailureMessage(error.exitCode, failure + "\n" + stderr),
          {
            cause: error,
          },
        );
      if (error.code === "start_failed")
        reported = new Error(
          "codex: failed to spawn. Is the 'codex' CLI installed?",
          { cause: error },
        );
    }
    if (failure && error instanceof CliProtocolError)
      reported = new Error(codexFailureMessage(1, failure + "\n" + stderr), {
        cause: error,
      });
    primary = { error: reported };
    throw reported;
  } finally {
    try {
      await cleanup?.();
    } catch (error) {
      if (primary)
        throw new AggregateError(
          [primary.error, error],
          "Codex execution and attachment cleanup failed",
          { cause: error },
        );
      throw error;
    }
  }
}

export const codexProvider: AgentProvider = {
  id: "codex",
  // Native web search is independent of shell network access, so the
  // filesystem remains read-only while searches can be enabled per turn.
  capabilities: { web: true, vision: true, unboundedContext: true },
  execute: executeCodex,
  stream: streamCodex,
};
