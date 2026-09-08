import Link from "next/link";
import styles from "./ConversationView.module.css";
export function LibraryNavigation() {
  return (
    <nav className={styles.nav} aria-label="Libraries">
      <Link href="/">Papers</Link>
      <Link href="/conversations">Conversations</Link>
      <a href="/offline/index.html">Downloads</a>
    </nav>
  );
}
