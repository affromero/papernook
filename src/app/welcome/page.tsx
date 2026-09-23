import { redirect } from "next/navigation";
import { requestIdentity, sharedAccess } from "@/lib/auth/access";
import { accessOrigins } from "@/lib/auth/platform/configuration";
import { profilePageFiles } from "@/lib/auth/platform/page-access";
import { isAccessError } from "thesidedoor-core/access";
import {
  configuredProviderId,
  detectLocalCliProvider,
  isProviderAvailable,
  hasConfiguredProvider,
} from "@/lib/agent/registry";
import { selectDetectedProvider, readAiState } from "@/lib/agent/config";
import { optionalWebdavUrl } from "@/lib/webdav-url";
import { WelcomeFlow } from "./WelcomeFlow";

export const dynamic = "force-dynamic";

/**
 * The wizard autocompletes from the environment (.env / secret manager):
 * agent status, the Shortcut share link, and the WebDAV credentials are read
 * server-side so the page shows values instead of instructions wherever the
 * instance is already provisioned.
 */
export default async function WelcomePage() {
  const admission = await requestIdentity();
  if (!admission?.capability) redirect("/login");
  const capability = admission.capability;

  let agentProvider: string | null = null;
  let agentAvailable = false;
  const initial = readAiState();
  let probedRevision = initial.revision;
  if (hasConfiguredProvider(initial.selection)) {
    agentProvider = configuredProviderId(initial.selection);
    agentAvailable = await isProviderAvailable(
      agentProvider as Parameters<typeof isProviderAvailable>[0],
      initial,
    );
  } else {
    // Auto-select only when no provider has been configured. An explicitly
    // selected provider that is unavailable remains visible as unavailable.
    const detected = admission.isAdmin ? await detectLocalCliProvider() : null;
    if (detected) {
      try {
        const result = await selectDetectedProvider(admission.token, detected);
        if (result.selected) probedRevision = result.revision;
      } catch (error) {
        if (
          isAccessError(error) &&
          ["unauthorized", "forbidden"].includes(error.code)
        )
          redirect("/login");
        throw error;
      }
      agentProvider = detected;
      agentAvailable = true;
    }
  }

  return profilePageFiles(capability, () => {
    const { identity, access, profiles } = sharedAccess();
    const state = identity.readSnapshot();
    const authenticated = access.sessionFromState(
      state.access,
      admission.token,
    );
    const selected = authenticated.principal
      ? state.bindings[authenticated.principal.id]
      : profiles.selectedFromState(state.access, admission.token)?.id;
    if (selected !== capability.username) redirect("/welcome");
    const profile = state.profiles.find(
      (entry) => entry.username === capability.username,
    );
    if (!profile) redirect("/login");
    const admin = access.householdOwnerFromState(state.access, admission.token);
    const baseUrl = accessOrigins().canonicalOrigin;
    const currentProvider = hasConfiguredProvider(state.ai.selection)
      ? configuredProviderId(state.ai.selection)
      : null;
    return (
      <WelcomeFlow
        displayName={profile.displayName}
        avatarSlug={profile.avatarSlug}
        captureToken={profile.captureToken}
        baseUrl={baseUrl}
        webdavUrl={optionalWebdavUrl(
          baseUrl,
          process.env.PAPERNOOK_WEBDAV_URL,
          process.env.WEBDAV_USER,
          process.env.WEBDAV_PASS,
        )}
        shortcutUrl={process.env.PAPERNOOK_SHORTCUT_URL ?? "/api/v1/shortcut"}
        agentProvider={currentProvider}
        agentAvailable={
          state.ai.revision === probedRevision &&
          currentProvider === agentProvider &&
          agentAvailable
        }
        webdavUser={process.env.WEBDAV_USER ?? null}
        webdavPass={process.env.WEBDAV_PASS ?? null}
        admin={admin}
      />
    );
  });
}
