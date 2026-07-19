import { redirect } from "next/navigation";
import { activeProfile } from "@/lib/auth/session";
import { listTopics } from "@/lib/library/papers";
import { ViewToggle } from "@/components/library/ViewToggle";
import { DiscoverClient } from "./DiscoverClient";
import styles from "./discover.module.css";

export const dynamic = "force-dynamic";

export default async function DiscoverPage() {
  const profile = await activeProfile();
  if (!profile) redirect("/login");
  if (!profile.wizardDone) redirect("/welcome");
  return (
    <main className={styles.root}>
      <header className={styles.header}>
        <ViewToggle active="discover" />
        <h1 className={styles.title}>What to read next</h1>
      </header>
      <DiscoverClient
        captureToken={profile.captureToken}
        topics={listTopics()}
      />
    </main>
  );
}
