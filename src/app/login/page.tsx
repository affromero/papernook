import { ProfilePicker } from "@/components/profiles/ProfilePicker";
import { listProfiles, toPublicProfile } from "@/lib/auth/users";
import { isPublicExposure } from "@/lib/data-dir";

export const dynamic = "force-dynamic";

export default function LoginPage() {
  const profiles = listProfiles().map(toPublicProfile);
  return <ProfilePicker profiles={profiles} publicMode={isPublicExposure()} />;
}
