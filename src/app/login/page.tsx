import { ProfilePicker } from "@/components/profiles/ProfilePicker";
import { AccessGate } from "@/components/profiles/AccessGate";
import {
  listProfiles,
  toPublicProfile,
  instancePasswordConfigured,
} from "@/lib/auth/users";
import { requestIsPublic } from "@/lib/auth/exposure";
import { gateRequired } from "@/lib/auth/gate";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  // Public instance with a shared password: the picker stays hidden (no
  // profile names, no Add button) until the access password is entered.
  if (await gateRequired()) {
    return <AccessGate />;
  }
  const profiles = listProfiles().map(toPublicProfile);
  return (
    <ProfilePicker
      profiles={profiles}
      publicMode={await requestIsPublic()}
      instancePassword={instancePasswordConfigured()}
    />
  );
}
