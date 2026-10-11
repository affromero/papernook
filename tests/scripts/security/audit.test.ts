import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "../../..");
const advisory = "https://github.com/advisories/GHSA-vfj7-8cjw-p6xm";
let directory: string;

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "papernook-audit-"));
  fs.mkdirSync(path.join(directory, "scripts/security"), { recursive: true });
  fs.mkdirSync(path.join(directory, "bin"));
  fs.copyFileSync(
    path.join(root, "scripts/security/audit.mjs"),
    path.join(directory, "scripts/security/audit.mjs"),
  );
  fs.writeFileSync(
    path.join(directory, "bin/npm"),
    `#!${process.execPath}
const fs = require('node:fs');
process.stdout.write(fs.readFileSync('audit-report', 'utf8'));
process.exit(Number(process.env.AUDIT_EXIT));
`,
    { mode: 0o755 },
  );
});
afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

interface Advisory {
  name: string;
  dependency: string;
  url: string;
  severity: string;
}

function report() {
  const causes: Record<string, (string | Advisory)[]> = {
    "eslint-config-next": ["@next/eslint-plugin-next"],
    "@next/eslint-plugin-next": ["fast-glob"],
    "fast-glob": ["micromatch"],
    micromatch: ["braces"],
    braces: [
      { name: "braces", dependency: "braces", url: advisory, severity: "high" },
    ],
  };
  return {
    auditReportVersion: 2,
    vulnerabilities: Object.fromEntries(
      Object.entries(causes).map(([name, via]) => [
        name,
        {
          name,
          severity: "high",
          isDirect: name === "eslint-config-next",
          nodes: [`node_modules/${name}`],
          via,
        },
      ]),
    ),
    metadata: {
      vulnerabilities: {
        info: 0,
        low: 0,
        moderate: 0,
        high: 5,
        critical: 0,
        total: 5,
      },
    },
  };
}

function run(value: unknown, status = 1) {
  fs.writeFileSync(
    path.join(directory, "audit-report"),
    typeof value === "string" ? value : JSON.stringify(value),
  );
  return spawnSync(process.execPath, ["scripts/security/audit.mjs"], {
    cwd: directory,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${directory}/bin:${process.env.PATH}`,
      AUDIT_EXIT: String(status),
    },
  });
}

it("blocks the formerly excepted development lint advisory", () => {
  const result = run(report());
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("Blocking dependency findings");
});

it("passes a complete audit report with no vulnerabilities", () => {
  const value = report();
  value.vulnerabilities = {};
  value.metadata.vulnerabilities.high = 0;
  value.metadata.vulnerabilities.total = 0;
  expect(run(value, 0).status).toBe(0);
});

it.each(["moderate", "high", "critical"])("blocks %s findings", (severity) => {
  const value = report();
  value.vulnerabilities = {};
  value.metadata.vulnerabilities.high = 0;
  value.metadata.vulnerabilities.total = 0;
  value.vulnerabilities["next"] = {
    name: "next",
    severity,
    isDirect: true,
    nodes: ["node_modules/next"],
    via: [
      {
        name: "next",
        dependency: "next",
        url: "https://github.com/advisories/another-advisory",
        severity,
      },
    ],
  };
  value.metadata.vulnerabilities.high += severity === "high" ? 1 : 0;
  value.metadata.vulnerabilities.moderate += severity === "moderate" ? 1 : 0;
  value.metadata.vulnerabilities.critical += severity === "critical" ? 1 : 0;
  value.metadata.vulnerabilities.total++;
  const result = run(value);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("next");
});

it.each(["missing", "low-package"])(
  "blocks malformed low-severity dependency causes: %s",
  (cause) => {
    const value = report();
    value.vulnerabilities["low-package"] = {
      name: "low-package",
      severity: "low",
      isDirect: false,
      nodes: ["node_modules/low-package"],
      via: [cause],
    };
    value.metadata.vulnerabilities.low++;
    value.metadata.vulnerabilities.total++;
    const result = run(value);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("audit cause");
  },
);

it("blocks unknown or cyclic dependency causes", () => {
  for (const cause of ["missing", "eslint-config-next"]) {
    const value = report();
    value.vulnerabilities["micromatch"]!.via = [cause];
    const result = run(value);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("audit cause");
  }
});

it.each(["not JSON", {}, { error: { code: "ENETUNREACH" } }])(
  "blocks incomplete or failed audit responses: %j",
  (value) => {
    const result = run(value);
    expect(result.status).not.toBe(0);
    expect(result.stderr).not.toBe("");
  },
);

it("blocks reports with missing vulnerability entries", () => {
  const value = report();
  delete value.vulnerabilities["braces"];
  const result = run(value);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("Inconsistent npm audit report");
});

it("blocks an audit process failure even if it prints a clean report", () => {
  const value = report();
  value.vulnerabilities = {};
  value.metadata.vulnerabilities.high = 0;
  value.metadata.vulnerabilities.total = 0;
  const result = run(value, 2);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("npm audit did not complete successfully");
});

it.each(["info", "low"])(
  "preserves the moderate threshold for valid %s findings",
  (severity) => {
    const value = report();
    value.vulnerabilities = {};
    value.metadata.vulnerabilities.high = 0;
    value.metadata.vulnerabilities.total = 0;
    value.vulnerabilities["another-package"] = {
      name: "another-package",
      severity,
      isDirect: false,
      nodes: ["node_modules/another-package"],
      via: [
        {
          name: "another-package",
          dependency: "another-package",
          url: "https://github.com/advisories/another-advisory",
          severity,
        },
      ],
    };
    if (severity === "info") value.metadata.vulnerabilities.info++;
    else value.metadata.vulnerabilities.low++;
    value.metadata.vulnerabilities.total++;
    expect(run(value).status).toBe(0);
  },
);

it("blocks high-severity causes even when a parent is marked low", () => {
  const value = report();
  value.vulnerabilities["another-package"] = {
    name: "another-package",
    severity: "low",
    isDirect: false,
    nodes: ["node_modules/another-package"],
    via: ["braces"],
  };
  value.metadata.vulnerabilities.low++;
  value.metadata.vulnerabilities.total++;
  const result = run(value);
  expect(result.status).not.toBe(0);
  expect(result.stderr.split("\n")[0]).toContain("another-package");
});
