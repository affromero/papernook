import { redirect } from "next/navigation";
import { requestIdentity } from "@/lib/auth/access";
import { LibraryView } from "@/components/library/LibraryView";
import { AccountBar } from "@/components/profiles/AccountBar";

export const dynamic = "force-dynamic";

interface HomePageProps {
  searchParams: Promise<{ q?: string; tag?: string; topic?: string }>;
}

export default async function HomePage({ searchParams }: HomePageProps) {
  const admission = await requestIdentity();
  const profile = admission?.profile;
  if (!profile || !admission.capability) redirect("/login");
  if (!profile.wizardDone) redirect("/welcome");
  const params = await searchParams;
  return (
    <main>
      <AccountBar
        displayName={profile.displayName}
        avatarSlug={profile.avatarSlug}
      />
      <LibraryView
        query={params.q ?? ""}
        activeTag={params.tag ?? null}
        activeTopic={params.topic ?? null}
        captureToken={profile.captureToken}
        capability={admission.capability}
      />
    </main>
  );
}
