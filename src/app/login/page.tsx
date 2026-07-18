import { ProfilePicker } from "@/components/profiles/ProfilePicker";
import { AccessGate } from "@/components/profiles/AccessGate";
import {
  listProfiles,
  toPublicProfile,
  instancePasswordConfigured,
} from "@/lib/auth/users";
import { isPublicExposure } from "@/lib/data-dir";
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
      publicMode={isPublicExposure()}
      instancePassword={instancePasswordConfigured()}
    />
  );
}
