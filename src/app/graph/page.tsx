import { redirect } from "next/navigation";
import { activeProfile } from "@/lib/auth/session";
import { ViewToggle } from "@/components/library/ViewToggle";
import { GraphClient } from "./GraphClient";
import styles from "./graph.module.css";

export const dynamic = "force-dynamic";

export default async function GraphPage() {
  const profile = await activeProfile();
  if (!profile) redirect("/login");
  return (
    <main className={styles.root}>
      <header className={styles.header}>
        <ViewToggle active="graph" />
        <h1 className={styles.title}>How your papers relate</h1>
      </header>
      <GraphClient />
    </main>
  );
}
