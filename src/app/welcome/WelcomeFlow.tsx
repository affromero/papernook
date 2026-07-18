"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import styles from "./welcome.module.css";

/**
 * Per-profile onboarding, modeled on Sotto's WelcomeFlow step machine.
 * Replays for every new profile (wizardDone flag): the install-level AI
 * connection is only *tested* here; it is configured once by the installer
 * (scripts/install.sh) or .env, never hardcoded.
 */

interface WelcomeFlowProps {
  displayName: string;
  captureToken: string;
  baseUrl: string;
  /** iCloud share link of the prebuilt Shortcut (PAPERNOOK_SHORTCUT_URL). */
  shortcutUrl: string | null;
}

type Step = "welcome" | "agent" | "capture" | "ipad" | "done";

/**
 * The WebDAV address that pairs with how the app is being reached: a domain
 * without a port (production behind TLS) gets the dav. subdomain; a
 * host:port (local dev, Tailscale IP) gets the sidecar port.
 */
function webdavUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  if (!url.port || url.port === "443") {
    return `https://dav.${url.hostname}`;
  }
  return `${url.protocol}//${url.hostname}:8080`;
}

const ORDER: Step[] = ["welcome", "agent", "capture", "ipad", "done"];

interface AgentStatus {
  provider: string | null;
  available: boolean;
  error?: string;
}

export function WelcomeFlow({
  displayName,
  captureToken,
  baseUrl,
  shortcutUrl,
}: WelcomeFlowProps) {
  const router = useRouter();
  const [step, setStep] = useState<Step>("welcome");
  const [agent, setAgent] = useState<AgentStatus | null>(null);
  const bookmarklet = `javascript:location.href='${baseUrl}/add?token=${captureToken}&url='+encodeURIComponent(location.href)`;

  useEffect(() => {
    if (step !== "agent") return;
    let cancelled = false;
    void fetch("/api/v1/agent/status", { credentials: "include" })
      .then((r) => r.json())
      .then((d: AgentStatus) => {
        if (!cancelled) setAgent(d);
      });
    return () => {
      cancelled = true;
    };
  }, [step]);

  async function finish(): Promise<void> {
    await fetch("/api/v1/session/wizard-done", {
      method: "POST",
      credentials: "include",
    });
    router.push("/");
    router.refresh();
  }

  const index = ORDER.indexOf(step);
  const next = () => setStep(ORDER[Math.min(index + 1, ORDER.length - 1)]);
  const back = () => setStep(ORDER[Math.max(index - 1, 0)]);

  return (
    <main className={styles.root}>
      <div className={styles.card}>
        <p className={styles.progress}>
          {index + 1} / {ORDER.length}
        </p>

        {step === "welcome" && (
          <>
            <h1>Welcome, {displayName}</h1>
            <p>
              papernook is your paper library: capture with one tap, annotate on
              the iPad with the Pencil, and study every paper with your own AI.
              This takes two minutes.
            </p>
          </>
        )}

        {step === "agent" && (
          <>
            <h1>Your AI</h1>
            {!agent && <p>Testing the configured agent…</p>}
            {agent && agent.available && (
              <p className={styles.ok}>
                ✓ <strong>{agent.provider}</strong> is connected and answering.
              </p>
            )}
            {agent && !agent.available && (
              <>
                <p className={styles.bad}>
                  ✗ No working agent (
                  {agent.error ?? `provider ${agent.provider} unreachable`}).
                </p>
                <p>
                  The server admin sets this once in <code>.env</code> (or via{" "}
                  <code>scripts/install.sh</code>): <code>AI_PROVIDER</code> ={" "}
                  <code>claude-code</code>, <code>codex</code>,{" "}
                  <code>anthropic</code>, or <code>openai</code>, plus an SSH
                  host or API key. You can continue; chat will work once it is
                  configured.
                </p>
              </>
            )}
          </>
        )}

        {step === "capture" && (
          <>
            <h1>One-tap capture</h1>
            <p>
              <strong>Chrome:</strong> drag this to the bookmarks bar:
            </p>
            <p>
              <a className={styles.bookmarklet} href={bookmarklet}>
                📚 Add to papernook
              </a>
            </p>
            {shortcutUrl ? (
              <p>
                <strong>Safari / iPhone / iPad:</strong>{" "}
                <a className={styles.bookmarklet} href={shortcutUrl}>
                  ⬇️ Get the Shortcut
                </a>{" "}
                Open on the device, tap Add Shortcut, and answer the two import
                questions: server <code>{baseUrl}</code> and your token below.
              </p>
            ) : (
              <p>
                <strong>Safari / iPhone / iPad:</strong> build the 3-step
                Shortcut (full recipe in Settings): Share Sheet → Get Contents
                of <code>{baseUrl}/add</code> (POST form: <code>url</code> =
                input, <code>token</code> = your token) → Show Web Page.
              </p>
            )}
            <p className={styles.tokenNote}>
              No Shortcut needed for a quick add: paste any link into the Add
              paper box at the top of your library.
            </p>
            <p className={styles.tokenNote}>
              Your personal token is on the Settings page; captures made with it
              are filed as you.
            </p>
          </>
        )}

        {step === "ipad" && (
          <>
            <h1>iPad annotation</h1>
            <ol>
              <li>
                Install <strong>PDF Expert</strong> (or Documents by Readdle) on
                the iPad.
              </li>
              <li>
                Add a connection: <strong>WebDAV</strong> →{" "}
                <code>{webdavUrl(baseUrl)}</code> with the WebDAV user and
                password (in Infisical, or the server&rsquo;s <code>.env</code>
                ).
              </li>
              <li>
                Open any paper, write with the Pencil; it saves straight into
                the same file papernook serves. No exports, ever.
              </li>
            </ol>
            <p>
              The QR to install papernook itself on the iPad home screen is in
              Settings → Connect a device.
            </p>
          </>
        )}

        {step === "done" && (
          <>
            <h1>Ready</h1>
            <p>
              Capture a paper, open it, ask your first question. Everything
              (PDFs, ink, chats, canvases) lives on your own server.
            </p>
          </>
        )}

        <div className={styles.actions}>
          {index > 0 && step !== "done" && (
            <button type="button" className={styles.ghost} onClick={back}>
              Back
            </button>
          )}
          {step !== "done" ? (
            <button type="button" className={styles.primary} onClick={next}>
              Continue
            </button>
          ) : (
            <button
              type="button"
              className={styles.primary}
              onClick={() => void finish()}
            >
              Open my library
            </button>
          )}
        </div>
      </div>
    </main>
  );
}
