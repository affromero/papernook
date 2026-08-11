import Link from "next/link";
import { redirect } from "next/navigation";
import { activeProfile } from "@/lib/auth/session";
import { findPaperBySource } from "@/lib/library/papers";
import { normalizeUrl } from "@/lib/capture/normalize";
import { ViewerShell } from "./ViewerShell";
import styles from "./viewer.module.css";

export const dynamic = "force-dynamic";

/**
 * Read an external PDF in the papernook reader without capturing it first.
 * The Safari extension redirects PDF navigations here; the reader's hover
 * previews for internal reference links work on any hyperref'd PDF.
 */

interface ViewerPageProps {
  searchParams: Promise<{ src?: string }>;
}

export async function generateMetadata({ searchParams }: ViewerPageProps) {
  const { src } = await searchParams;
  const url = parseHttpUrl(src);
  if (!url) return { title: "viewer" };
  return { title: fileName(url) };
}

/** Last path segment, decoded; a malformed %-escape falls back to the raw. */
function fileName(url: URL): string {
  const name = url.pathname.split("/").at(-1) || url.hostname;
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}

function parseHttpUrl(raw: string | undefined): URL | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

export default async function ViewerPage({ searchParams }: ViewerPageProps) {
  const profile = await activeProfile();
  if (!profile) redirect("/login");
  const { src } = await searchParams;
  const url = parseHttpUrl(src);

  if (!url) {
    return (
      <main className={styles.root}>
        <p className={styles.notice}>
          Nothing to show: open this page as <code>/viewer?src=…</code> with an
          http(s) PDF URL. <Link href="/">Back to the library</Link>
        </p>
      </main>
    );
  }

  // Already captured? Land on the library copy (annotations, chats) — or the
  // pending inbox confirmation — instead of the plain viewer.
  let arxivId: string | null = null;
  try {
    arxivId = normalizeUrl(url.href).arxivId;
  } catch {
    arxivId = null;
  }
  const existing = findPaperBySource(url.href, arxivId, profile.username);
  if (existing?.topic) redirect(`/paper/${existing.topic}/${existing.slug}`);
  if (existing) redirect(`/inbox/${existing.slug}`);

  return (
    <main className={styles.root}>
      <ViewerShell src={url.href} title={fileName(url)} />
    </main>
  );
}
