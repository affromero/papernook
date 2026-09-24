import { redirect } from "next/navigation";
import { ProfilePicker } from "@/components/profiles/ProfilePicker";
import { AccessGate } from "@/components/profiles/AccessGate";
import { toPublicProfile } from "@/lib/auth/users";
import { requestIdentity, sharedAccess } from "@/lib/auth/access";
import { isAccessError } from "thesidedoor-core/access";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  const identity = await requestIdentity();
  const { access, identity: storage } = sharedAccess();
  const state = await storage.read();
  let authenticated = null;
  if (identity) {
    try {
      authenticated = access.sessionFromState(state.access, identity.token);
    } catch (error) {
      if (
        !isAccessError(error) ||
        !["unauthorized", "forbidden"].includes(error.code)
      )
        throw error;
    }
  }
  if (!authenticated) return <AccessGate />;
  if (authenticated.principal) redirect("/");
  return (
    <ProfilePicker
      profiles={state.profiles.map((profile) =>
        toPublicProfile(
          profile,
          state.access.principals.some(
            (principal) =>
              principal.role === "owner" &&
              state.bindings[principal.id] === profile.username,
          ),
        ),
      )}
    />
  );
}
