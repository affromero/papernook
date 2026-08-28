import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const cli = path.resolve(import.meta.dirname, "../../scripts/papernook");

let workspace = "";
let clone = "";
let stubs = "";
let composeLog = "";
let dockerLog = "";
let healthVersion = "";

/**
 * Git exports GIT_DIR, GIT_INDEX_FILE and friends to the hooks it runs, and
 * this suite runs from the pre-push hook. Inheriting them aims every fixture
 * git command at the real repository — `git init` in the fixture then marks
 * the developer's clone bare and `git add -A` stages the whole tree as
 * deleted. Dropping them, and the user's global config with them, keeps the
 * fixture a fixture.
 */
function fixtureEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("GIT_")) delete env[key];
  }
  env.GIT_CONFIG_GLOBAL = "/dev/null";
  env.GIT_CONFIG_SYSTEM = "/dev/null";
  env.PATH = `${stubs}:${process.env.PATH ?? ""}`;
  return env;
}

function run(args: string[], cwd = clone): string {
  return execFileSync("./scripts/papernook", args, {
    cwd,
    encoding: "utf8",
    env: fixtureEnv(),
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function git(args: string[], cwd: string): string {
  return execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd,
    encoding: "utf8",
    env: fixtureEnv(),
  });
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
  fs.writeFileSync(
    path.join(origin, "package.json"),
    '{\n  "name": "papernook",\n  "version": "1.2.3",\n  "private": true\n}\n',
  );
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
  // Development continues past the release, as it does on a real main.
  fs.appendFileSync(path.join(origin, "docker-compose.yml"), "  search: {}\n");
  git(["add", "-A"], origin);
  git(
    ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "three"],
    origin,
  );

  clone = path.join(workspace, "clone");
  git(["clone", "-q", "--branch", "v0.1.0", origin, clone], workspace);

  // Stand in for the pieces an update touches on a real host.
  stubs = path.join(workspace, "stubs");
  fs.mkdirSync(stubs);
  // Records the version compose was handed, so the test can prove the
  // running stack is labelled with the commit it was built from.
  composeLog = path.join(workspace, "compose-version");
  // Every compose command, so a test can tell a pull from a build.
  dockerLog = path.join(workspace, "docker-args");
  fs.writeFileSync(
    path.join(stubs, "docker"),
    `#!/bin/sh\nprintf '%s' "$PAPERNOOK_VERSION" > ${composeLog}\n` +
      `echo "$*" >> ${dockerLog}\nexit 0\n`,
    { mode: 0o755 },
  );
  // The version the "running" stack reports, which the tests below vary to
  // stage a stack that lags its clone.
  healthVersion = path.join(workspace, "health-version");
  fs.writeFileSync(
    path.join(stubs, "curl"),
    `#!/bin/sh\nif [ -f ${healthVersion} ]; then\n` +
      `  printf '{"status":"ok","version":"%s"}\\n' "$(cat ${healthVersion})"\n` +
      `else\n  echo '{"status":"ok"}'\nfi\n`,
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

  it("labels the rebuilt stack with the release and the commit", () => {
    expect(fs.readFileSync(composeLog, "utf8")).toBe(
      `1.2.3+${git(["rev-parse", "--short", "HEAD"], clone).trim()}`,
    );
  });

  // A clone that follows main sits ahead of the newest tag; a release
  // "update" there would be a downgrade.
  it("refuses to move a branch checkout back to an older release", () => {
    git(["checkout", "-q", "main"], clone);
    git(["merge", "-q", "--ff-only", "origin/main"], clone);
    const head = git(["rev-parse", "HEAD"], clone).trim();
    expect(run(["update"])).toMatch(/refusing to move backwards/);
    expect(git(["rev-parse", "HEAD"], clone).trim()).toBe(head);
    expect(run(["status"])).toContain("already runs newer code");
  });

  // Production hit this: a release tag retagged upstream makes a plain
  // fetch abort with "would clobber existing tag", and every later update
  // with it.
  it("survives a release tag that moved upstream", () => {
    git(["tag", "-f", "v0.1.0", "main"], path.join(workspace, "origin"));
    expect(run(["update", "--main", "--no-backup"])).toContain(
      "Already on the newest main",
    );
  });

  // The update rewrites this very script; bash reads a script lazily, so a
  // body that is not one pre-parsed block resumes at an offset inside new
  // code. Cheap structural check — the failure it prevents is unrepeatable.
  it("parses its whole body before running any of it", () => {
    const source = fs.readFileSync(cli, "utf8");
    expect(source).toMatch(/\n\{\n/);
    expect(source.trimEnd().endsWith("}")).toBe(true);
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

// The production server has 75G for ten projects; a Next.js build there
// costs a build cache and a layer of every intermediate image. With
// PAPERNOOK_IMAGE set an update must pull the published image and never
// build one here.
describe("papernook update (prebuilt image)", () => {
  function stackReports(version: string): void {
    fs.writeFileSync(healthVersion, version);
  }

  function dockerCommands(): string[] {
    const log = fs.existsSync(dockerLog)
      ? fs.readFileSync(dockerLog, "utf8")
      : "";
    return log.split("\n").filter(Boolean);
  }

  beforeEach(() => {
    fs.rmSync(dockerLog, { force: true });
    fs.rmSync(healthVersion, { force: true });
    fs.rmSync(path.join(clone, ".env"), { force: true });
  });

  function currentVersion(): string {
    return `1.2.3+${git(["rev-parse", "--short", "HEAD"], clone).trim()}`;
  }

  it("deploys when the clone is current but the stack lags it", () => {
    stackReports("1.2.3+deadbee");
    const output = run(["update", "--main", "--no-backup"]);
    expect(output).toContain("but the stack runs 1.2.3+deadbee");
    expect(dockerCommands().join(" ")).toContain("up -d");
  });

  it("leaves a stack that already runs the checkout alone", () => {
    stackReports(currentVersion());
    expect(run(["update", "--main"])).toContain("Already on the newest main");
    expect(dockerCommands()).toEqual([]);
  });

  it("pulls the published image instead of building one", () => {
    fs.writeFileSync(
      path.join(clone, ".env"),
      "PAPERNOOK_IMAGE=registry.test/papernook\n",
    );
    stackReports("1.2.3+deadbee");
    const output = run(["update", "--main", "--no-backup"]);
    const commands = dockerCommands();
    // The tag follows the checkout, so image and reported version agree.
    const sha = git(["rev-parse", "--short", "HEAD"], clone).trim();
    expect(output).toContain(`registry.test/papernook:${sha}`);
    expect(commands).toContain("compose pull app");
    expect(commands.join(" ")).toContain("--no-build");
    expect(commands.join(" ")).not.toContain("--build ");
  });

  it("builds locally when no image is configured", () => {
    stackReports("1.2.3+deadbee");
    run(["update", "--main", "--no-backup"]);
    const commands = dockerCommands().join(" ");
    expect(commands).toContain("--build");
    expect(commands).not.toContain("pull");
  });
});
