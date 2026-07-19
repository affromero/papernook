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
  const publicMode = await requestIsPublic();
  const passwordConfigured = instancePasswordConfigured();
  if (publicMode && !passwordConfigured) {
    return <AccessGate configured={false} />;
  }
  // Public instances keep profile names and Add profile behind the one
  // admin-configured access password.
  if (await gateRequired()) {
    return <AccessGate />;
  }
  const profiles = listProfiles().map(toPublicProfile);
  return <ProfilePicker profiles={profiles} />;
}
