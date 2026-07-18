"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import styles from "./welcome.module.css";

/**
 * One-screen onboarding. Everything the instance already knows (from .env /
 * Infisical) is shown as a filled-in value, not an instruction: agent
 * status, the importable Shortcut link, and the WebDAV credentials. The
 * only actions left are taps: drag the bookmarklet, tap the Shortcut link,
 * copy the WebDAV login into PDF Expert.
 */

interface WelcomeFlowProps {
  displayName: string;
  captureToken: string;
  baseUrl: string;
  shortcutUrl: string | null;
  agentProvider: string | null;
  agentAvailable: boolean;
  webdavUser: string | null;
  webdavPass: string | null;
  admin: boolean;
}

function webdavUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  if (!url.port || url.port === "443") {
    return `https://dav.${url.hostname}`;
  }
  return `${url.protocol}//${url.hostname}:8080`;
}

export function WelcomeFlow({
  displayName,
  captureToken,
  baseUrl,
  shortcutUrl,
  agentProvider,
  agentAvailable,
  webdavUser,
  webdavPass,
  admin,
}: WelcomeFlowProps) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [showPass, setShowPass] = useState(false);
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
        <h1>Welcome, {displayName}</h1>
        <p>
          Your library is ready. Everything below is already configured; grab
          what your devices need and go.
        </p>

        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>
            {agentAvailable ? "✓" : "✗"} Your AI
          </h2>
          {agentAvailable ? (
            <p className={styles.ok}>
              <strong>{agentProvider}</strong> is connected and answering.
              Nothing to do.
            </p>
          ) : admin ? (
            <p className={styles.bad}>
              No working agent
              {agentProvider ? ` (provider ${agentProvider} unreachable)` : ""}.
              As the admin you set <code>AI_PROVIDER</code> (and its key or SSH
              host) in Infisical or <code>.env</code>, then redeploy. You can
              continue; chat activates once it answers.
            </p>
          ) : (
            <p className={styles.bad}>
              The AI is not connected yet. Your admin is on it; everything else
              already works.
            </p>
          )}
        </section>

        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>✓ Capture</h2>
          <p>
            Zero setup: paste any link into the <strong>Add paper</strong> box
            in your library.
          </p>
          {shortcutUrl && (
            <p>
              iPhone/iPad share sheet:{" "}
              <a className={styles.bookmarklet} href={shortcutUrl}>
                ⬇️ Get the Shortcut
              </a>{" "}
              then answer its two questions: server <code>{baseUrl}</code>,
              token below.
            </p>
          )}
          <p>
            Chrome: drag{" "}
            <a className={styles.bookmarklet} href={bookmarklet}>
              📚 Add to papernook
            </a>{" "}
            to the bookmarks bar.
          </p>
          <p className={styles.tokenNote}>
            Your capture token: <code>{captureToken}</code>
          </p>
        </section>

        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>✓ iPad annotation</h2>
          <p>
            PDF Expert (or Documents) → add a <strong>WebDAV</strong>{" "}
            connection:
          </p>
          <ul className={styles.credList}>
            <li>
              Address: <code>{webdavUrl(baseUrl)}</code>
            </li>
            <li>
              User: <code>{webdavUser ?? "(not configured)"}</code>
            </li>
            <li>
              Password:{" "}
              {webdavPass ? (
                showPass ? (
                  <code>{webdavPass}</code>
                ) : (
                  <button
                    type="button"
                    className={styles.reveal}
                    onClick={() => setShowPass(true)}
                  >
                    reveal
                  </button>
                )
              ) : (
                <code>(not configured)</code>
              )}
            </li>
          </ul>
          <p className={styles.tokenNote}>
            Ink lands in the PDF on your server. No exports, ever.
          </p>
        </section>

        <div className={styles.actions}>
          <button
            type="button"
            className={styles.primary}
            onClick={() => void finish()}
            disabled={busy}
          >
            Open my library
          </button>
        </div>
      </div>
    </main>
  );
}
