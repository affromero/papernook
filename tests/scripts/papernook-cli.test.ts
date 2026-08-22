import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const cli = path.resolve(import.meta.dirname, "../../scripts/papernook");

let workspace = "";
let clone = "";
let stubs = "";
let composeLog = "";

function run(args: string[], cwd = clone): string {
  return execFileSync("./scripts/papernook", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, PATH: `${stubs}:${process.env.PATH ?? ""}` },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

// A local origin with two releases, cloned at the older one: the shape a
// user who followed the tagged-install instructions ends up with.
beforeAll(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "papernook-cli-"));
  const origin = path.join(workspace, "origin");
  fs.mkdirSync(path.join(origin, "scripts"), { recursive: true });
  fs.copyFileSync(cli, path.join(origin, "scripts", "papernook"));
  fs.chmodSync(path.join(origin, "scripts", "papernook"), 0o755);
  fs.writeFileSync(path.join(origin, "docker-compose.yml"), "services:\n");
  git(["init", "-q", "-b", "main"], origin);
  git(["add", "-A"], origin);
  git(
    ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "one"],
    origin,
  );
  git(["tag", "v0.1.0"], origin);
  fs.appendFileSync(path.join(origin, "docker-compose.yml"), "  app: {}\n");
  git(["add", "-A"], origin);
  git(
    ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "two"],
    origin,
  );
  git(["tag", "v0.9.0"], origin);

  clone = path.join(workspace, "clone");
  git(["clone", "-q", "--branch", "v0.1.0", origin, clone], workspace);

  // Stand in for the pieces an update touches on a real host.
  stubs = path.join(workspace, "stubs");
  fs.mkdirSync(stubs);
  // Records the version compose was handed, so the test can prove the
  // running stack is labelled with the commit it was built from.
  composeLog = path.join(workspace, "compose-version");
  fs.writeFileSync(
    path.join(stubs, "docker"),
    `#!/bin/sh\nprintf '%s' "$PAPERNOOK_VERSION" > ${composeLog}\nexit 0\n`,
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(stubs, "curl"),
    '#!/bin/sh\necho \'{"status":"ok"}\'\n',
    { mode: 0o755 },
  );
});

afterAll(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe("papernook update", () => {
  it("reports the newer release without touching the clone", () => {
    const output = run(["update", "--check"]);
    expect(output).toContain("v0.1.0 → v0.9.0");
    expect(git(["describe", "--tags"], clone).trim()).toBe("v0.1.0");
  });

  it("refuses to update a clone with uncommitted changes", () => {
    fs.appendFileSync(path.join(clone, "docker-compose.yml"), "# edited\n");
    expect(() => run(["update", "--check"])).toThrow(/uncommitted changes/);
    git(["checkout", "--", "docker-compose.yml"], clone);
  });

  it("moves to the newest release and reports health", () => {
    const output = run(["update", "--no-backup"]);
    expect(git(["describe", "--tags"], clone).trim()).toBe("v0.9.0");
    expect(output).toContain('{"status":"ok"}');
    // Re-running is a no-op rather than a second rebuild.
    expect(run(["update"])).toContain("Already on the newest release");
  });

  it("labels the rebuilt stack with the commit it deployed", () => {
    expect(fs.readFileSync(composeLog, "utf8")).toBe(
      git(["rev-parse", "--short", "HEAD"], clone).trim(),
    );
  });

  it("installs a command that points back at the clone", () => {
    const binDir = path.join(workspace, "bin");
    run(["link", "--bin-dir", binDir]);
    const shim = fs.readFileSync(path.join(binDir, "papernook"), "utf8");
    expect(shim).toContain(clone);
    expect(
      execFileSync(path.join(binDir, "papernook"), ["help"], {
        encoding: "utf8",
      }),
    ).toContain("papernook update");
  });
});
