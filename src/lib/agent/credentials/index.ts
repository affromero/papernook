import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getClaudeSshHost, getCodexSshHost } from "../invocation";
import type { ProviderId } from "../types";

const SYNC_TIMEOUT_MS = 8_000;
const POLL_MS = 100;
let reloadQueue: Promise<unknown> = Promise.resolve();

/**
 * How far along a credentials file is in its rotation, or -1 when unreadable.
 *
 * Both CLIs mint a fresh refresh token on every OAuth refresh and the previous
 * one is retired server-side, so a snapshot taken before a rotation is dead the
 * moment it is restored. Neither file carries a generation counter, but both
 * carry a timestamp that only moves forward: Claude's refresh token expiry, and
 * Codex's last_refresh. That answers the only question here — is what I am
 * about to write older than what is already on disk? It cannot see a token
 * retired out of band, which is why an unreadable file always loses.
 */
export function credentialGeneration(
  provider: ProviderId,
  contents: string,
): number {
  try {
    const parsed = JSON.parse(contents) as {
      claudeAiOauth?: { refreshTokenExpiresAt?: unknown };
      last_refresh?: unknown;
    };
    if (provider === "claude-code") {
      const expiry = parsed?.claudeAiOauth?.refreshTokenExpiresAt;
      return typeof expiry === "number" ? expiry : -1;
    }
    const refreshed =
      typeof parsed?.last_refresh === "string"
        ? Date.parse(parsed.last_refresh)
        : Number.NaN;
    return Number.isNaN(refreshed) ? -1 : refreshed;
  } catch {
    return -1;
  }
}

/** True when `candidate` should replace whatever `pathname` currently holds. */
export function supersedesCredentials(
  provider: ProviderId,
  pathname: string,
  candidate: string,
): boolean {
  let existing: string;
  try {
    existing = fs.readFileSync(pathname, "utf8");
  } catch {
    return true; // Nothing there yet.
  }
  const current = credentialGeneration(provider, existing);
  if (current < 0) return true; // Unreadable or malformed — anything beats it.
  return credentialGeneration(provider, candidate) > current;
}

function syncRoot(): string | null {
  return process.env.PAPERNOOK_CREDENTIAL_SYNC_DIR || null;
}

export function credentialReloadAvailable(provider: ProviderId): boolean {
  const root = syncRoot();
  if (!root) return false;
  if (provider === "claude-code") {
    return (
      fs.existsSync(path.join(root, "supports-claude")) &&
      !getClaudeSshHost() &&
      !process.env.CLAUDE_CODE_CREDENTIALS_JSON &&
      !process.env.CLAUDE_CODE_OAUTH_TOKEN
    );
  }
  if (provider === "codex") {
    return (
      fs.existsSync(path.join(root, "supports-codex")) && !getCodexSshHost()
    );
  }
  return false;
}

function credentialPaths(provider: ProviderId): {
  snapshot: string;
  runtime: string;
} {
  const root = syncRoot();
  if (!root) throw new Error("Credential reload is not configured.");
  const home = process.env.HOME;
  if (!home) throw new Error("The app runtime HOME is not configured.");
  if (provider === "claude-code") {
    return {
      snapshot: path.join(root, "claude-credentials.json"),
      runtime: path.join(
        process.env.CLAUDE_HOME || home,
        ".claude",
        ".credentials.json",
      ),
    };
  }
  if (provider === "codex") {
    return {
      snapshot: path.join(root, "codex-auth.json"),
      // CODEX_HOME is the config directory itself — that is how codex.ts hands
      // it to the CLI. Reload has to write the file the CLI rotates, or a
      // custom CODEX_HOME splits rotation from reload silently.
      runtime: path.join(
        process.env.CODEX_HOME || path.join(home, ".codex"),
        "auth.json",
      ),
    };
  }
  throw new Error("Only local CLI credentials can be reloaded.");
}

async function waitFor(pathname: string): Promise<void> {
  const deadline = Date.now() + SYNC_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (fs.existsSync(pathname)) return;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  throw new Error("The credential sync service did not answer in time.");
}

export type CredentialReloadOutcome = "installed" | "skipped" | "removed";

function installSnapshot(
  provider: ProviderId,
  snapshot: string,
  runtime: string,
): CredentialReloadOutcome {
  if (!fs.existsSync(snapshot)) {
    // An absent snapshot means the host signed out. Reload is an explicit
    // operator action, so honour it — unlike container startup, which must
    // never delete the only rotated token it has.
    fs.rmSync(runtime, { force: true });
    return "removed";
  }
  const contents = fs.readFileSync(snapshot, "utf8");
  const parsed: unknown = JSON.parse(contents);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("The host credential file is not a JSON object.");
  }
  if (!supersedesCredentials(provider, runtime, contents)) {
    // The host copy is read-only, so it cannot receive rotations; restoring it
    // over a newer runtime file would hand back a token the server retired.
    return "skipped";
  }
  fs.mkdirSync(path.dirname(runtime), { recursive: true });
  const temporary = `${runtime}.${crypto.randomUUID()}.tmp`;
  // 0660: the volume is shared with the other apps driving this login, which
  // run as a different uid; its directory is setgid to their common group.
  fs.writeFileSync(temporary, contents, { mode: 0o660 });
  fs.renameSync(temporary, runtime);
  return "installed";
}

async function performReload(
  provider: ProviderId,
): Promise<CredentialReloadOutcome> {
  if (!credentialReloadAvailable(provider)) {
    throw new Error("Credential reload is unavailable for this provider.");
  }
  const root = syncRoot() as string;
  const nonce = crypto.randomBytes(16).toString("hex");
  const request = path.join(root, "requests", nonce);
  const response = path.join(root, "responses", nonce);
  fs.writeFileSync(request, "", { flag: "wx" });
  try {
    await waitFor(response);
    const { snapshot, runtime } = credentialPaths(provider);
    return installSnapshot(provider, snapshot, runtime);
  } finally {
    fs.rmSync(request, { force: true });
    fs.rmSync(response, { force: true });
  }
}

export function reloadProviderCredentials(
  provider: ProviderId,
): Promise<CredentialReloadOutcome> {
  const reload = reloadQueue.then(() => performReload(provider));
  reloadQueue = reload.catch(() => undefined);
  return reload;
}
