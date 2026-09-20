import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";

let directory: string;
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "papernook-start-"));
  fs.mkdirSync(path.join(directory, "scripts"));
  fs.mkdirSync(path.join(directory, "scripts/runtime"));
  fs.mkdirSync(path.join(directory, "bin"));
  fs.mkdirSync(path.join(directory, "data"));
  fs.writeFileSync(path.join(directory, "data/private.json"), "private-data");
  fs.writeFileSync(path.join(directory, ".env"), "WEBDAV_PASS=test-only\n");
  fs.copyFileSync(
    path.resolve(import.meta.dirname, "../../scripts/runtime/start-stack.sh"),
    path.join(directory, "scripts/runtime/start-stack.sh"),
  );
  fs.copyFileSync(
    path.resolve(import.meta.dirname, "../../scripts/backup.sh"),
    path.join(directory, "scripts/backup.sh"),
  );
  fs.writeFileSync(
    path.join(directory, "bin/docker"),
    `#!/usr/bin/env node
const fs = require('node:fs');
let args = process.argv.slice(2);
if (args[0] === 'image') { console.log('sha256:prepared'); process.exit(0); }
if (args[1] === '--project-directory') {
  const config = JSON.parse(fs.readFileSync(args[4], 'utf8'));
  fs.appendFileSync('configurations', JSON.stringify(config) + '\\n');
  args = ['compose', ...args.slice(5)];
}
const command = args.join(' ');
fs.appendFileSync('commands', command + '\\n');
if (command === 'compose config --format json') {
  console.log(JSON.stringify({name:'fixture', services:{app:{image:'app:mutable', build:'.', environment:{TOKEN:'private-test-value'}}, webdav:{image:'webdav:mutable'}}}));
}
if (command.startsWith('compose ps ')) {
  const service = args.at(-1);
  if (fs.existsSync(service + '.running')) console.log(service);
}
if (command === 'compose stop app webdav') {
  fs.rmSync('app.running', {force:true});
  if (process.env.FAIL_COMMAND === 'partial-stop' && !fs.existsSync('stop-attempted')) {
    fs.writeFileSync('stop-attempted', '1'); process.exit(1);
  }
  fs.rmSync('webdav.running', {force:true});
}
if (command.startsWith('compose up ')) {
  fs.writeFileSync('app.running', '1'); fs.writeFileSync('webdav.running', '1');
}
if (process.env.FAIL_COMMAND && command.includes(process.env.FAIL_COMMAND)) process.exit(1);
`,
    { mode: 0o755 },
  );
});

afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

function start(failure = "", backup = "no-backup") {
  return spawnSync(
    "bash",
    ["scripts/runtime/start-stack.sh", "build", backup],
    {
      cwd: directory,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${directory}/bin:${process.env.PATH}`,
        FAIL_COMMAND: failure,
      },
    },
  );
}

function commands() {
  return fs.readFileSync(path.join(directory, "commands"), "utf8");
}

it("pins prepared images and retains environment through initialization and healthy startup", () => {
  const result = start();
  expect(result.status, result.stderr).toBe(0);
  expect(commands()).toMatch(
    /build app[\s\S]*stop app webdav[\s\S]*access.cjs initialize[\s\S]*up .*--wait --wait-timeout 90/,
  );
  const configurations = fs
    .readFileSync(path.join(directory, "configurations"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const final = configurations.at(-1);
  expect(final.name).toBe("fixture");
  expect(final.services.app.image).toBe("sha256:prepared");
  expect(final.services.webdav.image).toBe("sha256:prepared");
  expect(final.services.app.build).toBeUndefined();
  expect(final.services.app.environment.TOKEN).toBe("private-test-value");
  expect(result.stdout + result.stderr).not.toContain("private-test-value");
});

it.each(["access.cjs initialize", "compose up ", "partial-stop"])(
  "leaves all writers stopped when %s fails",
  (failure) => {
    fs.writeFileSync(path.join(directory, "app.running"), "1");
    fs.writeFileSync(path.join(directory, "webdav.running"), "1");
    const result = start(failure);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("App and WebDAV remain stopped");
    expect(fs.existsSync(path.join(directory, "app.running"))).toBe(false);
    expect(fs.existsSync(path.join(directory, "webdav.running"))).toBe(false);
    if (failure !== "compose up ")
      expect(commands()).not.toContain("compose up ");
  },
);

it("keeps the existing app serving when image preparation fails", () => {
  fs.writeFileSync(path.join(directory, "app.running"), "1");
  expect(start("build app").status).not.toBe(0);
  expect(fs.existsSync(path.join(directory, "app.running"))).toBe(true);
  expect(commands()).not.toContain("stop app webdav");
});

it("rejects invalid access configuration before stopping writers", () => {
  fs.writeFileSync(path.join(directory, "app.running"), "1");
  expect(start("validate-config").status).not.toBe(0);
  expect(commands()).toContain(
    "--entrypoint node app scripts/access.cjs validate-config",
  );
  expect(commands()).not.toContain("stop app webdav");
  expect(fs.existsSync(path.join(directory, "app.running"))).toBe(true);
});

it("captures private data before initialization without restarting writers", () => {
  const result = start("access.cjs initialize", "backup");
  expect(result.status).not.toBe(0);
  const backups = fs.readdirSync(path.join(directory, "backups"));
  expect(backups).toHaveLength(1);
  const archive = spawnSync(
    "tar",
    ["-xOf", path.join(directory, "backups", backups[0]!), "data/private.json"],
    { encoding: "utf8" },
  );
  expect(archive.status, archive.stderr).toBe(0);
  expect(archive.stdout).toBe("private-data");
  expect(commands()).not.toContain("compose start");
  expect(result.stderr).toContain("Pre-initialization backup:");
});

it("does not initialize when backup creation fails", () => {
  fs.writeFileSync(path.join(directory, "backups"), "occupied");
  const result = start("", "backup");
  expect(result.status).not.toBe(0);
  expect(commands()).not.toContain("access.cjs initialize");
  expect(result.stderr).toContain("App and WebDAV remain stopped");
});

function backup(args: string[], failure = "") {
  return spawnSync("bash", ["scripts/backup.sh", ...args], {
    cwd: directory,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${directory}/bin:${process.env.PATH}`,
      FAIL_COMMAND: failure,
    },
  });
}

it("standalone backup restarts only services that were originally running", () => {
  fs.writeFileSync(path.join(directory, "app.running"), "1");
  const result = backup([]);
  expect(result.status, result.stderr).toBe(0);
  expect(commands()).toContain("compose start app\n");
  expect(commands()).not.toContain("compose start app webdav");
});

it("refuses a stopped-mode backup while a writer is still running", () => {
  fs.writeFileSync(path.join(directory, "webdav.running"), "1");
  const result = backup(["--stopped"]);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("webdav is running");
  expect(commands()).not.toContain("compose stop");
  expect(commands()).not.toContain("compose start");
});

it.each([{ args: [] }, { args: ["--stopped"] }])(
  "aborts backup when Docker cannot inspect writers (%j)",
  ({ args }) => {
    const result = backup(args, "compose ps");
    expect(result.status).not.toBe(0);
    expect(commands()).not.toContain("compose stop");
    expect(commands()).not.toContain("compose start");
    expect(fs.readdirSync(path.join(directory, "backups"))).toEqual([]);
  },
);
