import { ProfilePicker } from "@/components/profiles/ProfilePicker";
import { AccessGate } from "@/components/profiles/AccessGate";
import {
  listProfiles,
  toPublicProfile,
  instancePasswordConfigured,
} from "@/lib/auth/users";
import { gateRequired } from "@/lib/auth/gate";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  if (!instancePasswordConfigured()) {
    return <AccessGate configured={false} />;
  }
  // Profile names and Add profile stay behind the one access password.
  if (await gateRequired()) {
    return <AccessGate />;
  }
  const profiles = listProfiles().map(toPublicProfile);
  return <ProfilePicker profiles={profiles} />;
}
