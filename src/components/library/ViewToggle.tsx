import Link from "next/link";
import styles from "./ViewToggle.module.css";

/** Segmented switch between the library's ways of seeing the same papers. */

const VIEWS = [
  { id: "library", label: "Library", href: "/" },
  { id: "graph", label: "Graph", href: "/graph" },
  { id: "discover", label: "Discover", href: "/discover" },
] as const;

export type ViewId = (typeof VIEWS)[number]["id"];

export function ViewToggle({ active }: { active: ViewId }) {
  return (
    <nav className={styles.root} aria-label="Library views">
      {VIEWS.map((view) => (
        <Link
          key={view.id}
          href={view.href}
          className={active === view.id ? styles.active : styles.link}
          aria-current={active === view.id ? "page" : undefined}
        >
          {view.label}
        </Link>
      ))}
    </nav>
  );
}
