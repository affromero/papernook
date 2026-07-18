import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { activeProfile } from "@/lib/auth/session";
import { WelcomeFlow } from "./WelcomeFlow";

export const dynamic = "force-dynamic";

export default async function WelcomePage() {
  const profile = await activeProfile();
  if (!profile) redirect("/login");

  const headerStore = await headers();
  const host = headerStore.get("host") ?? "localhost:3000";
  const proto = headerStore.get("x-forwarded-proto") ?? "http";
  return (
    <WelcomeFlow
      displayName={profile.displayName}
      captureToken={profile.captureToken}
      baseUrl={`${proto}://${host}`}
      shortcutUrl={process.env.PAPERNOOK_SHORTCUT_URL ?? null}
    />
  );
}
