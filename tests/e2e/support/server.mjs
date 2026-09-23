import { execFileSync, spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
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
      name: "Fixture Owner",
      password: "browser-owner-password-phrase",
      mode: "household",
    }),
  });
  if (!response.ok)
    throw new Error(`Browser fixture owner claim failed (${response.status})`);
  const ownerCookie = response.headers.get("set-cookie");
  if (!ownerCookie)
    throw new Error("Browser fixture owner claim did not create a session");
  const cookie = ownerCookie.split(";", 1)[0];
  const profile = await fetch(`${origin}/api/v1/profiles`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: origin,
      Cookie: cookie,
    },
    body: JSON.stringify({ displayName: "Maya", avatarSlug: "hummingbird" }),
  });
  if (!profile.ok)
    throw new Error(`Browser fixture profile setup failed (${profile.status})`);
  const selectedOwner = await fetch(`${origin}/api/v1/access/select-profile`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: origin,
      Cookie: cookie,
    },
    body: JSON.stringify({ id: "fixture-owner" }),
  });
  if (!selectedOwner.ok)
    throw new Error(
      `Browser fixture Admin selection failed (${selectedOwner.status})`,
    );
  const adminCookie =
    selectedOwner.headers.get("set-cookie")?.split(";", 1)[0] ?? cookie;
  const provider = await fetch(`${origin}/api/v1/agent/model`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Origin: origin,
      Cookie: adminCookie,
    },
    body: JSON.stringify({ provider: "codex", revision: 0 }),
  });
  if (!provider.ok)
    throw new Error(
      `Browser fixture provider setup failed (${provider.status})`,
    );
  const wizard = await fetch(`${origin}/api/v1/session/wizard-done`, {
    method: "POST",
    headers: { Origin: origin, Cookie: adminCookie },
  });
  if (!wizard.ok)
    throw new Error(
      `Browser fixture onboarding setup failed (${wizard.status})`,
    );
  const admitted = await fetch(`${origin}/api/v1/access/household`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({ password: "browser-owner-password-phrase" }),
  });
  if (!admitted.ok)
    throw new Error(
      `Browser fixture household admission failed (${admitted.status})`,
    );
  const householdCookie = admitted.headers.get("set-cookie")?.split(";", 1)[0];
  if (!householdCookie)
    throw new Error(
      "Browser fixture household admission did not create a session",
    );
  const selected = await fetch(`${origin}/api/v1/access/select-profile`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: origin,
      Cookie: householdCookie,
    },
    body: JSON.stringify({ id: "maya" }),
  });
  if (!selected.ok)
    throw new Error(
      `Browser fixture profile selection failed (${selected.status})`,
    );
  const memberCookie =
    selected.headers.get("set-cookie")?.split(";", 1)[0] ?? householdCookie;
  const memberWizard = await fetch(`${origin}/api/v1/session/wizard-done`, {
    method: "POST",
    headers: { Origin: origin, Cookie: memberCookie },
  });
  if (!memberWizard.ok)
    throw new Error(
      `Browser fixture profile onboarding failed (${memberWizard.status})`,
    );
  const separator = memberCookie.indexOf("=");
  if (separator <= 0)
    throw new Error("Browser fixture member session cookie is invalid");
  await writeFile(
    path.join(env.PAPERNOOK_DATA_DIR, ".maya-storage-state.json"),
    JSON.stringify({
      cookies: [
        {
          name: memberCookie.slice(0, separator),
          value: memberCookie.slice(separator + 1),
          domain: "127.0.0.1",
          path: "/",
          expires: -1,
          httpOnly: true,
          secure: false,
          sameSite: "Lax",
        },
      ],
      origins: [],
    }),
    { mode: 0o600 },
  );
  console.log("Browser fixture ready");
} catch (error) {
  server.kill("SIGTERM");
  process.exitCode = 1;
  console.error(error);
}
