#!/usr/bin/env node
// Seed a CLI credentials file from the host snapshot at container start.
//
// The snapshot is a copy of the host's login taken through a read-only mount,
// so it can never receive a rotation. Both CLIs mint a new refresh token on
// every OAuth refresh and the server retires the previous one, which makes an
// older snapshot actively harmful: restoring it hands the CLI a credential the
// server has already invalidated. So this installs only when the snapshot is
// newer than what is on disk, and never deletes — an absent snapshot at startup
// means "nothing to seed", not "sign out". Signing out is an explicit operator
// action through the reload endpoint, which still removes the runtime file.
//
// Runs in the entrypoint because jq is not in the image and no POSIX shell can
// compare these files honestly: the comparison is a JSON parse plus a
// provider-specific timestamp, not a text match.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";

const [provider, snapshotPath, runtimePath] = process.argv.slice(2);
if (!provider || !snapshotPath || !runtimePath) {
  console.error(
    "usage: seed-cli-credentials.mjs <provider> <snapshot> <runtime>",
  );
  process.exit(2);
}

/** How far along a credentials file is in its rotation, or -1 when unreadable. */
function generation(contents) {
  try {
    const parsed = JSON.parse(contents);
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

function read(pathname) {
  try {
    return readFileSync(pathname, "utf8");
  } catch {
    return null;
  }
}

const snapshot = read(snapshotPath);
if (!snapshot || !snapshot.trim()) {
  console.log(
    `[setup] No ${provider} snapshot to seed; keeping what is on disk`,
  );
  process.exit(0);
}

try {
  JSON.parse(snapshot);
} catch {
  console.log(
    `[setup] WARNING: the ${provider} snapshot is not JSON; ignoring it`,
  );
  process.exit(0);
}

const runtime = read(runtimePath);
if (runtime !== null) {
  const current = generation(runtime);
  // An unreadable runtime file loses to anything; a newer one always wins.
  if (current >= 0 && generation(snapshot) <= current) {
    console.log(
      `[setup] Kept the ${provider} credentials already on disk (newer than the host copy)`,
    );
    process.exit(0);
  }
}

mkdirSync(dirname(runtimePath), { recursive: true });
const temporary = `${runtimePath}.${randomUUID()}.tmp`;
writeFileSync(temporary, snapshot, { mode: 0o660 });
renameSync(temporary, runtimePath);
console.log(`[setup] Seeded ${provider} credentials from the host`);
