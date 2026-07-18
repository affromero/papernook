import { redirect } from "next/navigation";
import { activeProfile } from "@/lib/auth/session";
import { LibraryView } from "@/components/library/LibraryView";

export const dynamic = "force-dynamic";

interface HomePageProps {
  searchParams: Promise<{ q?: string; tag?: string; topic?: string }>;
}

export default async function HomePage({ searchParams }: HomePageProps) {
  const profile = await activeProfile();
  if (!profile) redirect("/login");
  if (!profile.wizardDone) redirect("/welcome");
  const params = await searchParams;
  return (
    <main>
      <LibraryView
        query={params.q ?? ""}
        activeTag={params.tag ?? null}
        activeTopic={params.topic ?? null}
        captureToken={profile.captureToken}
      />
    </main>
  );
}
