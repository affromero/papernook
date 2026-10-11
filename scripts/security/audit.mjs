import { spawnSync } from "node:child_process";
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
  const validated = new Map();
  function validateCauses(name, path = new Set()) {
    if (path.has(name)) throw new Error(`Cyclic audit cause: ${name}`);
    if (validated.has(name)) return validated.get(name);
    const finding = report.vulnerabilities[name];
    if (!record(finding)) throw new Error(`Missing audit cause: ${name}`);
    const next = new Set([...path, name]);
    let severity = severities.indexOf(finding.severity);
    for (const cause of finding.via) {
      severity = Math.max(
        severity,
        typeof cause === "string"
          ? validateCauses(cause, next)
          : severities.indexOf(cause.severity),
      );
    }
    validated.set(name, severity);
    return severity;
  }
  for (const [name] of findings) validateCauses(name);
  const blocked = findings.filter(([name]) => validated.get(name) >= 2);
  if (blocked.length) {
    throw new Error(
      `Blocking dependency findings: ${blocked.map(([name]) => name).join(", ")}`,
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
