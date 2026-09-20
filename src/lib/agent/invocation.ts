import { supervisedRemoteRequest } from "thesidedoor-core/runtime/ssh";
import type { ProcessRequest } from "thesidedoor-core/runtime/process";

/**
 * Direct-or-SSH command construction for CLI-backed providers.
 * When an SSH host is configured the whole
 * argv is single-quoted and wrapped in `ssh -o BatchMode=yes -T <host> ...`.
 */

/**
 * Variables a spawned CLI needs to run at all: find its binary, locate its own
 * credential file, talk to an SSH agent, write temp files.
 */
const BASE_ENV_KEYS = [
  "PATH",
  "HOME",
  "LANG",
  "LC_ALL",
  "TERM",
  "TMPDIR",
  "USER",
  "LOGNAME",
  "SHELL",
  "SSH_AUTH_SOCK",
  // Networks that force egress through a proxy or a private CA: without
  // these the CLI cannot reach its API even though the app itself can.
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
];

/**
 * The environment a CLI provider is spawned with. Inheriting the app's own
 * environment would put WEBDAV_PASS, SESSION_SECRET and
 * every other provider's API key inside a process that a prompt-injected
 * paper can steer, so the child gets an allowlist instead: the base variables
 * above plus the exact keys the provider needs. Named keys rather than a
 * prefix match, so a future CODEX_INTERNAL_TOKEN or ANTHROPIC_ADMIN_KEY is
 * absent by default instead of being swept in by its name.
 */
export function minimalAgentEnvironment(
  providerKeys: string[],
): NodeJS.ProcessEnv {
  const env: Record<string, string | undefined> = {};
  for (const key of [...BASE_ENV_KEYS, ...providerKeys]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env as NodeJS.ProcessEnv;
}

function sshOptions(): string[] {
  const options = ["-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes"];
  const key = process.env.PAPERNOOK_SSH_KEY_PATH;
  const knownHosts = process.env.PAPERNOOK_SSH_KNOWN_HOSTS_PATH;
  if (key) options.push("-i", key);
  if (knownHosts) options.push("-o", `UserKnownHostsFile=${knownHosts}`);
  return options;
}

/** Single-quote a value for safe interpolation into a remote shell command. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Resolve direct local execution or an SSH-wrapped remote agent invocation. */
export function buildAgentInvocation(
  cli: string,
  args: string[],
  sshHost?: string,
): { command: string; args: string[] } {
  if (!sshHost) return { command: cli, args };
  const remote = [cli, ...args].map(shellQuote).join(" ");
  return { command: "ssh", args: [...sshOptions(), "-T", sshHost, remote] };
}

/** scp local files to a remote directory (BatchMode, no prompts). */
export function buildScpInvocation(
  localPaths: string[],
  sshHost: string,
  remoteDir: string,
): { command: string; args: string[] } {
  return {
    command: "scp",
    args: [...sshOptions(), ...localPaths, `${sshHost}:${remoteDir}/`],
  };
}

export function getClaudeSshHost(): string | undefined {
  return process.env.CLAUDE_CODE_SSH_HOST || undefined;
}

export function getCodexSshHost(): string | undefined {
  return process.env.CODEX_SSH_HOST || undefined;
}

/** Remote execution uses the shared supervisor and the remote host's selected credentials. */
export function agentProcessRequest(request: {
  cli: "claude" | "codex";
  args: string[];
  input: string;
  environment: ProcessRequest["environment"];
  signal?: AbortSignal;
  timeoutMs: number;
  sshHost?: string;
}): ProcessRequest {
  if (!request.sshHost)
    return {
      command: request.cli,
      args: request.args,
      input: request.input,
      environment: request.environment,
      signal: request.signal,
      timeoutMs: request.timeoutMs,
    };
  return supervisedRemoteRequest({
    connection: {
      host: request.sshHost,
      identityFile: process.env.PAPERNOOK_SSH_KEY_PATH,
      knownHostsFile: process.env.PAPERNOOK_SSH_KNOWN_HOSTS_PATH,
    },
    command: request.cli,
    args: request.args,
    input: request.input,
    transportEnvironment: minimalAgentEnvironment([]),
    remoteEnvironmentKeys: [
      ...BASE_ENV_KEYS,
      ...(request.cli === "codex"
        ? ["CODEX_HOME", "CODEX_API_KEY"]
        : [
            "CLAUDE_HOME",
            "CLAUDE_CONFIG_DIR",
            "CLAUDE_CODE_OAUTH_TOKEN",
            "ANTHROPIC_API_KEY",
            "ANTHROPIC_BASE_URL",
            "ANTHROPIC_AUTH_TOKEN",
          ]),
    ],
    signal: request.signal,
    timeoutMs: request.timeoutMs,
  });
}
