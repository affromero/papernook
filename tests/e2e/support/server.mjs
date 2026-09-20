import { execFileSync, spawn } from "node:child_process";
import { setTimeout } from "node:timers/promises";
import { providerDescriptors } from "thesidedoor-core/ai/catalog";

const env = { ...process.env };
for (const descriptor of providerDescriptors()) {
  for (const field of descriptor.fields) {
    for (const name of field.environment ?? []) delete env[name];
  }
}
delete env.OPENAI_COMPATIBLE_API_KEY;
const origin = env.PAPERNOOK_URL;
if (origin !== "http://127.0.0.1:3107")
  throw new Error("Unexpected browser fixture origin");
const run = (args) =>
  execFileSync(process.execPath, args, { env, encoding: "utf8" });
run(["tests/e2e/seed.mjs"]);
run(["scripts/sidedoor/build-access.mjs"]);
run(["scripts/build-offline.mjs"]);
run([".next/operator/access.cjs", "initialize"]);
const { code } = JSON.parse(run([".next/operator/access.cjs", "claim"]));
const server = spawn(
  process.execPath,
  [
    "node_modules/next/dist/bin/next",
    "dev",
    "--hostname",
    "127.0.0.1",
    "--port",
    "3107",
  ],
  { env, stdio: "inherit" },
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => server.kill(signal));
server.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
try {
  let ready = false;
  for (let attempt = 0; attempt < 120; attempt++) {
    if (server.exitCode !== null)
      throw new Error("Browser fixture server exited before startup");
    try {
      ready = (
        await fetch(`${origin}/login`, { signal: AbortSignal.timeout(1000) })
      ).ok;
    } catch {
      ready = false;
    }
    if (ready) break;
    await setTimeout(500);
  }
  if (!ready) throw new Error("Browser fixture server did not become ready");
  const response = await fetch(`${origin}/api/v1/access/claim`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({
      token: code,
      name: "Maya",
      password: "browser-owner-password-phrase",
      mode: "household",
    }),
  });
  if (!response.ok)
    throw new Error(`Browser fixture owner claim failed (${response.status})`);
  const ownerCookie = response.headers.get("set-cookie");
  if (!ownerCookie) throw new Error("Browser fixture owner claim did not create a session");
  const household = await fetch(`${origin}/api/v1/access/configure-household`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: origin,
      Cookie: ownerCookie,
    },
    body: JSON.stringify({ password: "browser-owner-password-phrase" }),
  });
  if (!household.ok)
    throw new Error(`Browser fixture household setup failed (${household.status})`);
  console.log("Browser fixture ready");
} catch (error) {
  server.kill("SIGTERM");
  process.exitCode = 1;
  console.error(error);
}
