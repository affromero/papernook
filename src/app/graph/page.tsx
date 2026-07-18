import Link from "next/link";
import { redirect } from "next/navigation";
import { activeProfile } from "@/lib/auth/session";
import { GraphClient } from "./GraphClient";
import styles from "./graph.module.css";

export const dynamic = "force-dynamic";

export default async function GraphPage() {
  const profile = await activeProfile();
  if (!profile) redirect("/login");
  return (
    <main className={styles.root}>
      <header className={styles.header}>
        <Link href="/" className={styles.back}>
          ← Library
        </Link>
        <h1 className={styles.title}>How your papers relate</h1>
      </header>
      <GraphClient />
    </main>
  );
}
