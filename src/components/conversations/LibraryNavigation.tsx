"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { BookOpen, Download, MessagesSquare } from "lucide-react";
import styles from "./ConversationView.module.css";
export function LibraryNavigation({ sidebar = false }: { sidebar?: boolean }) {
  const pathname = usePathname();
  const conversations =
    pathname === "/conversations" || pathname.startsWith("/conversations/");
  return (
    <nav
      className={`${styles.nav} ${sidebar ? styles.sidebarNav : ""}`}
      aria-label="Libraries"
    >
      <Link href="/" aria-current={pathname === "/" ? "page" : undefined}>
        <BookOpen size={18} aria-hidden="true" /> Papers
      </Link>
      <Link
        href="/conversations"
        aria-current={conversations ? "page" : undefined}
      >
        <MessagesSquare size={18} aria-hidden="true" /> Conversations
      </Link>
      <a href="/offline/index.html">
        <Download size={18} aria-hidden="true" /> Downloads
      </a>
    </nav>
  );
}
