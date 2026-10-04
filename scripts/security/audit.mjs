import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// No patched braces release exists for this advisory. Accept it only through
// the development-only Next lint chain. Remove this exception when patched.
const advisory = "https://github.com/advisories/GHSA-vfj7-8cjw-p6xm";
const chain = new Map([
  ["eslint-config-next", "@next/eslint-plugin-next"],
  ["@next/eslint-plugin-next", "fast-glob"],
  ["fast-glob", "micromatch"],
  ["micromatch", "braces"],
  ["braces", null],
]);
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
  const lock = JSON.parse(
    readFileSync(new URL("../../package-lock.json", import.meta.url), "utf8"),
  );
  const packages = lock.packages;
  if (!record(packages) || !record(packages[""]))
    throw new Error("Invalid dependency lockfile");

  const lintOnly =
    packages[""].devDependencies?.["eslint-config-next"] &&
    [...chain].every(([name, dependency]) => {
      const installed = packages[`node_modules/${name}`];
      return (
        record(installed) &&
        installed.dev === true &&
        (!dependency || installed.dependencies?.[dependency]) &&
        !packages[""].dependencies?.[name] &&
        (name === "eslint-config-next" || !packages[""].devDependencies?.[name])
      );
    });
  const parents = new Map(
    [...chain]
      .filter(([, child]) => child)
      .map(([parent, child]) => [child, `node_modules/${parent}`]),
  );
  parents.set("eslint-config-next", "");
  const exclusiveLintChain = Object.entries(packages).every(
    ([node, installed]) =>
      record(installed) &&
      [...chain.keys()].every(
        (name) =>
          (!installed.dependencies?.[name] &&
            !installed.optionalDependencies?.[name] &&
            !installed.peerDependencies?.[name]) ||
          (name !== "eslint-config-next" && parents.get(name) === node),
      ),
  );

  function excepted(name, visited = new Set()) {
    if (
      !lintOnly ||
      !exclusiveLintChain ||
      !chain.has(name) ||
      visited.has(name)
    )
      return false;
    const finding = report.vulnerabilities[name];
    const node = `node_modules/${name}`;
    const installed = packages[node];
    if (
      !record(finding) ||
      finding.isDirect !== (name === "eslint-config-next") ||
      finding.nodes.length !== 1 ||
      finding.nodes[0] !== node ||
      !record(installed) ||
      installed.dev !== true
    )
      return false;
    const dependency = chain.get(name);
    if (dependency && !installed.dependencies?.[dependency]) return false;
    if (
      name === "eslint-config-next" &&
      (!packages[""].devDependencies?.[name] ||
        packages[""].dependencies?.[name])
    )
      return false;
    if (name === "braces" && installed.version !== "3.0.3") return false;
    const path = new Set([...visited, name]);
    return finding.via.every((cause) => {
      if (typeof cause === "string")
        return cause === dependency && excepted(cause, path);
      return (
        name === "braces" &&
        cause.name === "braces" &&
        cause.dependency === "braces" &&
        cause.url === advisory
      );
    });
  }

  const blocked = findings.filter(
    ([name]) => validated.get(name) >= 2 && !excepted(name),
  );
  if (blocked.length) {
    throw new Error(
      `Blocking dependency findings: ${blocked.map(([name]) => name).join(", ")}`,
    );
  }
  const accepted = findings.filter(([name]) => excepted(name));
  if (accepted.length)
    console.log(`Accepted development-only lint advisory: ${advisory}`);
  console.log(
    "Dependency audit passed. All other moderate-or-higher findings remain blocking.",
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  if (result.stdout) console.error(result.stdout);
  if (result.stderr) console.error(result.stderr);
  process.exitCode = 1;
}
