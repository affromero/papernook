import { redirect } from "next/navigation";
import { activeProfile } from "@/lib/auth/session";
import { listTopics } from "@/lib/library/papers";
import { ImportReading } from "@/components/share/ImportReading";

export const dynamic = "force-dynamic";
export const metadata = {
  title: "Import a shared reading · papernook",
  referrer: "no-referrer",
};

export default async function ImportPage({
  searchParams,
}: {
  searchParams: Promise<{ url?: string; mode?: string }>;
}) {
  if (!(await activeProfile())) redirect("/login");
  const query = await searchParams;
  return (
    <main>
      <ImportReading
        initialUrl={query.url?.slice(0, 4500) ?? ""}
        initialMode={query.mode ?? "fork"}
        topics={listTopics()}
      />
    </main>
  );
}
