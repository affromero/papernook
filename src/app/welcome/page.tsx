import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { activeProfile } from "@/lib/auth/session";
import { isAdmin } from "@/lib/auth/users";
import {
  configuredProviderId,
  isProviderAvailable,
} from "@/lib/agent/registry";
import { WelcomeFlow } from "./WelcomeFlow";

export const dynamic = "force-dynamic";

/**
 * The wizard autocompletes from the environment (.env / Infisical): agent
 * status, the Shortcut share link, and the WebDAV credentials are all read
 * server-side so the page shows values instead of instructions wherever the
 * instance is already provisioned.
 */
export default async function WelcomePage() {
  const profile = await activeProfile();
  if (!profile) redirect("/login");

  const headerStore = await headers();
  const host = headerStore.get("host") ?? "localhost:3000";
  const proto = headerStore.get("x-forwarded-proto") ?? "http";

  let agentProvider: string | null = null;
  let agentAvailable = false;
  try {
    agentProvider = configuredProviderId();
    agentAvailable = await isProviderAvailable(
      agentProvider as Parameters<typeof isProviderAvailable>[0],
    );
  } catch {
    // unconfigured; the wizard explains instead of failing
  }

  return (
    <WelcomeFlow
      displayName={profile.displayName}
      captureToken={profile.captureToken}
      baseUrl={`${proto}://${host}`}
      shortcutUrl={
        process.env.PAPERNOOK_SHORTCUT_URL ?? "/add-to-papernook.shortcut"
      }
      agentProvider={agentProvider}
      agentAvailable={agentAvailable}
      webdavUser={process.env.WEBDAV_USER ?? null}
      webdavPass={process.env.WEBDAV_PASS ?? null}
      admin={isAdmin(profile)}
    />
  );
}
