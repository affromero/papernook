"use client";

import { useState } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { ModelPicker } from "@/components/profiles/ModelPicker";
import styles from "./welcome.module.css";

/**
 * One-screen onboarding. Everything the instance knows from its environment
 * renders as a finished value with a Copy button; the only actions
 * left are taps. Sections are device-oriented: chat works already, capture
 * is one tap per device, annotation is one login in PDF Expert.
 */

interface WelcomeFlowProps {
  displayName: string;
  avatarSlug: string;
  captureToken: string;
  baseUrl: string;
  webdavUrl: string;
  shortcutUrl: string | null;
  agentProvider: string | null;
  agentAvailable: boolean;
  webdavUser: string | null;
  webdavPass: string | null;
  admin: boolean;
}

function CopyRow({
  label,
  value,
  secret = false,
}: {
  label: string;
  value: string;
  secret?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <div className={styles.copyRow}>
      <span className={styles.copyLabel}>{label}</span>
      <code className={styles.copyValue}>
        {secret ? "•".repeat(10) : value}
      </code>
      <button
        type="button"
        className={styles.copyBtn}
        onClick={() => {
          void navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

export function WelcomeFlow({
  displayName,
  avatarSlug,
  captureToken,
  baseUrl,
  webdavUrl,
  shortcutUrl,
  agentProvider,
  agentAvailable,
  webdavUser,
  webdavPass,
  admin,
}: WelcomeFlowProps) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const bookmarklet = `javascript:location.href='${baseUrl}/add?token=${captureToken}&url='+encodeURIComponent(location.href)`;

  async function finish(): Promise<void> {
    setBusy(true);
    await fetch("/api/v1/session/wizard-done", {
      method: "POST",
      credentials: "include",
    });
    router.push("/");
    router.refresh();
  }

  return (
    <main className={styles.root}>
      <div className={styles.card}>
        <header className={styles.hero}>
          <Image
            src={`/avatars/${avatarSlug}.png`}
            alt=""
            width={64}
            height={64}
            className={styles.heroAvatar}
          />
          <div>
            <h1 className={styles.heroTitle}>Welcome, {displayName}</h1>
            <p className={styles.heroSub}>
              Your library is ready. Two taps and one login below, then read.
            </p>
          </div>
        </header>

        <section className={styles.section}>
          <div className={styles.sectionHead}>
            <span
              className={agentAvailable ? styles.dotOk : styles.dotBad}
              aria-hidden="true"
            />
            <h2 className={styles.sectionTitle}>Chat</h2>
            <span className={styles.sectionState}>
              {agentAvailable ? "works now" : "not connected"}
            </span>
          </div>
          {agentAvailable ? (
            <p className={styles.sectionBody}>
              Every paper gets a chat grounded in its text, answered by{" "}
              <strong>{agentProvider}</strong> on this server.
            </p>
          ) : (
            !admin && (
              <p className={styles.sectionBody}>
                Your admin is connecting the AI. Everything else works
                meanwhile.
              </p>
            )
          )}
          {admin && <ModelPicker />}
        </section>

        <section className={styles.section}>
          <div className={styles.sectionHead}>
            <span className={styles.dotOk} aria-hidden="true" />
            <h2 className={styles.sectionTitle}>Add papers</h2>
            <span className={styles.sectionState}>zero setup</span>
          </div>
          <p className={styles.sectionBody}>
            Paste an arXiv/OpenReview link, a direct PDF, or a publisher page
            that exposes its PDF into <strong>Add paper</strong>. For one-tap
            browser capture:
          </p>
          {shortcutUrl && (
            <a className={styles.action} href={shortcutUrl}>
              <span className={styles.actionTitle}>⬇️ Get the Shortcut</span>
              <span className={styles.actionSub}>
                iPhone / iPad share sheet. It asks for the server and your
                token; both are below.
              </span>
            </a>
          )}
          <a className={styles.action} href={bookmarklet}>
            <span className={styles.actionTitle}>📚 Add to papernook</span>
            <span className={styles.actionSub}>
              Chrome: drag this to the bookmarks bar.
            </span>
          </a>
          <CopyRow label="Server" value={baseUrl} />
          <CopyRow label="Token" value={captureToken} secret />
        </section>

        <section className={styles.section}>
          <div className={styles.sectionHead}>
            <span className={styles.dotOk} aria-hidden="true" />
            <h2 className={styles.sectionTitle}>Write on papers</h2>
            <span className={styles.sectionState}>one login</span>
          </div>
          <p className={styles.sectionBody}>
            Not in Apple&rsquo;s Files app; its &ldquo;Connect to Server&rdquo;
            only speaks SMB and rejects this address. Inside the PDF app:
          </p>
          <ol className={styles.steps}>
            <li>
              Install <strong>Documents by Readdle</strong> (free) or{" "}
              <strong>PDF Viewer by Nutrient</strong> (free, unlimited
              annotations). PDF Expert works too but needs a subscription.
            </li>
            <li>
              Documents: <strong>+ Add Connection → WebDAV Server</strong>. PDF
              Viewer / PDF Expert: add a WebDAV location from the connections
              screen.
            </li>
            <li>
              Paste the values below. Open a paper, write with the Pencil; ink
              saves into the PDF here. No exports, ever.
            </li>
          </ol>
          <CopyRow label="Address" value={webdavUrl} />
          {webdavUser && <CopyRow label="User" value={webdavUser} />}
          {webdavPass && <CopyRow label="Password" value={webdavPass} secret />}
        </section>

        <button
          type="button"
          className={styles.primary}
          onClick={() => void finish()}
          disabled={busy}
        >
          Open my library
        </button>
      </div>
    </main>
  );
}
