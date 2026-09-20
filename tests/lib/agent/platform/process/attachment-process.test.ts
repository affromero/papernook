import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { stageImagesOverSsh } from "@/lib/agent/attachments";

let directory: string;
function executable(name: string, body: string) {
  fs.writeFileSync(
    path.join(directory, name),
    `#!${process.execPath}\nconst fs = require('node:fs');\n${body}`,
    { mode: 0o700 },
  );
}
beforeEach(() => {
  directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "papernook-attachment-process-"),
  );
  vi.stubEnv("PATH", directory + path.delimiter + process.env.PATH);
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(directory, { recursive: true, force: true });
});

it.each(["mkdir", "scp"])(
  "stops cancelled %s before bounded remote cleanup",
  async (phase) => {
    const pidFile = path.join(directory, "pid");
    const cleaned = path.join(directory, "cleaned");
    const hang = `fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`;
    executable(
      "ssh",
      `if (process.argv.at(-1).includes("'rm'")) fs.writeFileSync(${JSON.stringify(cleaned)}, 'yes');
    else { ${phase === "mkdir" ? hang : "process.exitCode = 0;"} }`,
    );
    executable("scp", hang);
    const controller = new AbortController();
    const staging = stageImagesOverSsh(["/local/image.png"], "fixture-host", {
      signal: controller.signal,
    });
    const settled = staging.then(
      () => undefined,
      (error: unknown) => error,
    );
    await vi.waitFor(() => expect(fs.existsSync(pidFile)).toBe(true), {
      timeout: 10_000,
    });
    const pid = Number(fs.readFileSync(pidFile, "utf8"));
    controller.abort(new Error("transfer cancelled"));
    expect(await settled).toBe(controller.signal.reason);
    expect(() => process.kill(pid, 0)).toThrow();
    expect(fs.readFileSync(cleaned, "utf8")).toBe("yes");
  },
);

it("reports both staging and cleanup failures without hiding remote cleanup failure", async () => {
  executable(
    "ssh",
    `if (process.argv.at(-1).includes("'rm'")) { process.stderr.write('cleanup denied'); process.exitCode=1; }`,
  );
  executable(
    "scp",
    `process.stderr.write('transfer denied'); process.exitCode=1;`,
  );
  const result = await stageImagesOverSsh(
    ["/local/image.png"],
    "fixture-host",
  ).catch((error: unknown) => error);
  expect(result).toBeInstanceOf(AggregateError);
  expect(result).toMatchObject({
    errors: [
      expect.objectContaining({
        message: expect.stringContaining("transfer denied"),
      }),
      expect.objectContaining({
        message: expect.stringContaining("cleanup denied"),
      }),
    ],
  });
});

it("keeps application secrets out of transport processes", async () => {
  vi.stubEnv("SESSION_SECRET", "test-private-session-secret");
  executable("ssh", `if (process.env.SESSION_SECRET) process.exitCode=2;`);
  executable("scp", `if (process.env.SESSION_SECRET) process.exitCode=2;`);
  const result = await stageImagesOverSsh(["/local/image.png"], "fixture-host");
  expect(result.paths).toHaveLength(1);
  await result.cleanup();
});

it("keeps identical basenames separate and resolves option-like or colon-bearing local names", async () => {
  const transfers = path.join(directory, "transfers");
  executable("ssh", "process.exitCode = 0;");
  executable(
    "scp",
    `fs.appendFileSync(${JSON.stringify(transfers)}, JSON.stringify(process.argv.slice(2))+'\\n');`,
  );
  const paths = [
    "/first/crop.png",
    "/second/crop.png",
    "host:image.png",
    "-image.png",
  ];
  const result = await stageImagesOverSsh(paths, "fixture-host");
  expect(new Set(result.paths).size).toBe(4);
  const calls: string[][] = fs
    .readFileSync(transfers, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(calls.map((args) => args.at(-2))).toEqual(
    paths.map((file) => path.resolve(file)),
  );
  expect(calls.map((args) => args.at(-1))).toEqual(
    result.paths.map((file) => `fixture-host:${path.dirname(file)}/`),
  );
  await result.cleanup();
});
