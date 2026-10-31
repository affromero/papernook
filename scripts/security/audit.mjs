import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const severities = ["info", "low", "moderate", "high", "critical"];
const root = fileURLToPath(new URL("../../", import.meta.url));
const result = spawnSync("npm", ["audit", "--json"], {
  cwd: root,
  encoding: "utf8",
  maxBuffer: 16 * 1024 * 1024,
});

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

try {
  if (result.error || result.signal || ![0, 1].includes(result.status)) {
    throw new Error("npm audit did not complete successfully");
  }
  const report = JSON.parse(result.stdout);
  if (
    !record(report) ||
    report.error ||
    report.auditReportVersion !== 2 ||
    !record(report.vulnerabilities) ||
    !record(report.metadata?.vulnerabilities)
  ) {
    throw new Error("Invalid npm audit report");
  }
  const findings = Object.entries(report.vulnerabilities);
  const counts = Object.fromEntries(
    severities.map((severity) => [severity, 0]),
  );
  for (const [name, finding] of findings) {
    if (
      !record(finding) ||
      finding.name !== name ||
      !severities.includes(finding.severity) ||
      typeof finding.isDirect !== "boolean" ||
      !Array.isArray(finding.nodes) ||
      finding.nodes.length === 0 ||
      !finding.nodes.every((node) => typeof node === "string") ||
      !Array.isArray(finding.via) ||
      finding.via.length === 0 ||
      !finding.via.every(
        (cause) =>
          typeof cause === "string" ||
          (record(cause) &&
            typeof cause.name === "string" &&
            typeof cause.dependency === "string" &&
            typeof cause.url === "string" &&
            severities.includes(cause.severity)),
      )
    ) {
      throw new Error(`Invalid audit finding: ${name}`);
    }
    counts[finding.severity]++;
  }
  if (
    report.metadata.vulnerabilities.total !== findings.length ||
    severities.some(
      (severity) =>
        report.metadata.vulnerabilities[severity] !== counts[severity],
    ) ||
    (result.status === 0 && findings.length !== 0) ||
    (result.status === 1 && findings.length === 0)
  ) {
    throw new Error("Inconsistent npm audit report");
  }
  const parents = new Map(findings.map(([name]) => [name, new Set()]));
  const original = new Map(findings.map(([name]) => [name, -1]));
  const remaining = new Map(original);
  let lock;
  let excepted = false;
  function reviewedMinimatch(name, finding, cause) {
    if (
      name !== "minimatch" ||
      cause.name !== "minimatch" ||
      cause.dependency !== "minimatch" ||
      cause.url !== "https://github.com/advisories/GHSA-g3hv-75wg-m249"
    ) {
      return false;
    }
    lock ??= JSON.parse(
      readFileSync(new URL("../../package-lock.json", import.meta.url), "utf8"),
    );
    // The reviewed 3.1.5 parser has no vulnerable globparts preprocessing.
    return finding.nodes.every((node) => {
      const entry = lock.packages?.[node];
      return (
        entry?.version === "3.1.5" &&
        entry.resolved ===
          "https://registry.npmjs.org/minimatch/-/minimatch-3.1.5.tgz" &&
        entry.integrity ===
          "sha512-VgjWUsnnT6n+NUk6eZq77zeFdpW2LWDzP6zFGrCbHXiYNul5Dzqk2HHQ5uFH2DNW5Xbp8+jVzaeNt94ssEEl4w=="
      );
    });
  }
  for (const [name, finding] of findings) {
    for (const cause of finding.via) {
      if (typeof cause === "string") {
        if (!parents.has(cause))
          throw new Error(`Missing audit cause: ${cause}`);
        parents.get(cause).add(name);
        continue;
      }
      const severity = severities.indexOf(cause.severity);
      original.set(name, Math.max(original.get(name), severity));
      if (reviewedMinimatch(name, finding, cause)) {
        excepted = true;
        continue;
      }
      remaining.set(name, Math.max(remaining.get(name), severity));
    }
  }
  function propagate(initial) {
    const values = new Map(initial);
    const pending = [...values.keys()].filter((name) => values.get(name) >= 0);
    for (let i = 0; i < pending.length; i++) {
      const name = pending[i];
      for (const parent of parents.get(name)) {
        if (values.get(parent) >= values.get(name)) continue;
        values.set(parent, values.get(name));
        pending.push(parent);
      }
    }
    return values;
  }
  const justified = propagate(original);
  for (const [name, finding] of findings) {
    if (justified.get(name) < 0)
      throw new Error(`Unresolved audit cause: ${name}`);
    if (severities.indexOf(finding.severity) > justified.get(name)) {
      throw new Error(`Unexplained audit severity: ${name}`);
    }
  }
  const validated = propagate(remaining);
  const blocked = findings.filter(([name]) => validated.get(name) >= 2);
  if (blocked.length) {
    throw new Error(
      `Blocking dependency findings: ${blocked.map(([name]) => name).join(", ")}`,
    );
  }
  if (excepted) {
    console.log(
      "Verified false positive: GHSA-g3hv-75wg-m249 in minimatch 3.1.5.",
    );
  }
  console.log(
    "Dependency audit passed. Moderate-or-higher findings remain blocking.",
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  if (result.stdout) console.error(result.stdout);
  if (result.stderr) console.error(result.stderr);
  process.exitCode = 1;
}
