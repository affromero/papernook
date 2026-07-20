/**
 * Direct-or-SSH command construction for CLI-backed providers, ported from
 * Sotto's agent-invocation.ts. When an SSH host is configured the whole
 * argv is single-quoted and wrapped in `ssh -o BatchMode=yes -T <host> ...`.
 */

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
