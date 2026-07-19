import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { activeProfile } from "@/lib/auth/session";
import { isAdmin } from "@/lib/auth/users";
import {
  configuredProviderId,
  detectLocalCliProvider,
  isProviderAvailable,
} from "@/lib/agent/registry";
import { setAgentProvider } from "@/lib/agent/config";
import { resolveWebdavUrl } from "@/lib/webdav-url";
import { WelcomeFlow } from "./WelcomeFlow";

export const dynamic = "force-dynamic";

/**
 * The wizard autocompletes from the environment (.env / secret manager):
 * agent status, the Shortcut share link, and the WebDAV credentials are read
 * server-side so the page shows values instead of instructions wherever the
 * instance is already provisioned.
 */
export default async function WelcomePage() {
  const profile = await activeProfile();
  if (!profile) redirect("/login");

  const headerStore = await headers();
  const host = headerStore.get("host") ?? "localhost:3000";
  const proto = headerStore.get("x-forwarded-proto") ?? "http";
  const baseUrl = `${proto}://${host}`;

  let agentProvider: string | null = null;
  let agentAvailable = false;
  try {
    agentProvider = configuredProviderId();
    agentAvailable = await isProviderAvailable(
      agentProvider as Parameters<typeof isProviderAvailable>[0],
    );
  } catch {
    // Auto-select only when no provider has been configured. An explicitly
    // selected provider that is unavailable remains visible as unavailable.
    const detected = await detectLocalCliProvider();
    if (detected) {
      setAgentProvider(detected);
      agentProvider = detected;
      agentAvailable = true;
    }
  }

  return (
    <WelcomeFlow
      displayName={profile.displayName}
      avatarSlug={profile.avatarSlug}
      captureToken={profile.captureToken}
      baseUrl={baseUrl}
      webdavUrl={resolveWebdavUrl(baseUrl, process.env.PAPERNOOK_WEBDAV_URL)}
      shortcutUrl={process.env.PAPERNOOK_SHORTCUT_URL ?? "/api/v1/shortcut"}
      agentProvider={agentProvider}
      agentAvailable={agentAvailable}
      webdavUser={process.env.WEBDAV_USER ?? null}
      webdavPass={process.env.WEBDAV_PASS ?? null}
      admin={isAdmin(profile)}
    />
  );
}
