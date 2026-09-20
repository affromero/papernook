import Link from "next/link";
import { redirect } from "next/navigation";
import { ProfilePicker } from "@/components/profiles/ProfilePicker";
import { AccessGate } from "@/components/profiles/AccessGate";
import { toPublicProfile } from "@/lib/auth/users";
import { requestIdentity, sharedAccess } from "@/lib/auth/access";
import { isAccessError } from "thesidedoor-core/access";

export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ account?: string }>;
}) {
  const account = (await searchParams).account === "1";
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
  if (!authenticated || account)
    return (
      <AccessGate
        initialMode={
          account || state.access.mode === "individual" ? "login" : "household"
        }
      />
    );
  if (authenticated.principal) redirect("/");
  return (
    <>
      <ProfilePicker
        profiles={state.profiles.map((profile) => toPublicProfile(profile))}
      />
      <Link href="/login?account=1">
        Sign in to an individual account or recover access
      </Link>
    </>
  );
}
