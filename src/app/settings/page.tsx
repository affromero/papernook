import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { activeProfile } from "@/lib/auth/session";
import { isAdmin, listProfiles, toPublicProfile } from "@/lib/auth/users";
import { AdminMembers } from "@/components/profiles/AdminMembers";
import { InviteQr } from "@/components/profiles/InviteQr";
import { ModelPicker } from "@/components/profiles/ModelPicker";
import { ZoteroCard } from "@/components/profiles/ZoteroCard";
import { createInviteToken } from "@/lib/auth/gate";
import { instancePasswordConfigured } from "@/lib/auth/users";
import { DevicePanel } from "@/components/pwa/DevicePanel";
import styles from "./settings.module.css";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const profile = await activeProfile();
  if (!profile) redirect("/login");
  const admin = isAdmin(profile);

  const headerStore = await headers();
  const host = headerStore.get("host") ?? "localhost:3000";
  const proto = headerStore.get("x-forwarded-proto") ?? "http";
  const base = `${proto}://${host}`;
  const bookmarklet = `javascript:location.href='${base}/add?token=${profile.captureToken}&url='+encodeURIComponent(location.href)`;
  const shortcutUrl = `${base}/add`;
  const shortcutShareUrl =
    process.env.PAPERNOOK_SHORTCUT_URL ?? "/api/v1/shortcut";

  return (
    <main className={styles.root}>
      <h1>Settings: capture</h1>

      <section className={styles.card}>
        <h2>Chrome (desktop): bookmarklet</h2>
        <p>
          Drag this link to your bookmarks bar. On any paper page, click it and
          you land on the confirmation page.
        </p>
        <a className={styles.bookmarklet} href={bookmarklet}>
          📚 Add to papernook
        </a>
      </section>

      <section className={styles.card}>
        <h2>Safari (iPhone / iPad / Mac): Shortcut</h2>
        {shortcutShareUrl && (
          <p>
            <a className={styles.bookmarklet} href={shortcutShareUrl}>
              ⬇️ Get the Shortcut
            </a>{" "}
            Open on the device, tap Add Shortcut, answer the two import
            questions (server <code>{base}</code>, token below). Manual recipe
            as fallback:
          </p>
        )}
        <p>Create a Shortcut once, three steps in the Shortcuts app:</p>
        <ol>
          <li>
            New Shortcut → add <strong>Receive input from Share Sheet</strong>{" "}
            (type: URLs).
          </li>
          <li>
            Add <strong>Get Contents of URL</strong> → URL:{" "}
            <code>{shortcutUrl}</code>, Method <code>POST</code>, Request Body{" "}
            <code>Form</code> with fields <code>url</code> = Shortcut Input and{" "}
            <code>token</code> ={" "}
            <code className={styles.token}>{profile.captureToken}</code>.
          </li>
          <li>
            Add <strong>Show Web Page</strong> with the result. Name it
            &ldquo;Add to papernook&rdquo;.
          </li>
        </ol>
        <p>Then on any paper page: Share → Add to papernook → confirm. Done.</p>
      </section>

      <section className={styles.card}>
        <h2>Zotero sync</h2>
        <ZoteroCard />
      </section>

      {admin && (
        <section className={styles.card}>
          <h2>AI model</h2>
          <ModelPicker />
        </section>
      )}

      {admin && (
        <section className={styles.card}>
          <h2>Members</h2>
          <p>
            You are the admin: you own the instance configuration (agent,
            passwords, secrets in Infisical). Members only pick a name and an
            avatar.
          </p>
          <AdminMembers
            members={listProfiles()
              .map(toPublicProfile)
              .map((p) => ({
                username: p.username,
                displayName: p.displayName,
                isAdmin: p.isAdmin,
              }))}
          />
        </section>
      )}

      <section className={styles.card}>
        <h2>Invite a friend</h2>
        {admin && instancePasswordConfigured() && (
          <InviteQr inviteUrl={`${base}/invite?t=${createInviteToken()}`} />
        )}
        <ol>
          <li>
            {admin
              ? "Send the invite link or the QR above; no password typing for them. Or send the URL plus the access password."
              : "Ask the admin for an invite link or the access password, then open the URL."}
          </li>
          <li>
            They open papernook → <strong>Add profile</strong> on the picker.
          </li>
          <li>
            Their personal setup wizard runs automatically: their own
            bookmarklet and Shortcut token, plus the iPad walkthrough. Their
            chats stay private; the paper library is shared.
          </li>
        </ol>
      </section>

      <section className={styles.card}>
        <h2>Connect a device</h2>
        <p>
          Scan from the iPad or phone to open papernook and add it to the home
          screen. Private-first: Tailscale or same Wi-Fi.
        </p>
        <DevicePanel url={base} />
      </section>

      <section className={styles.card}>
        <h2>iPad WebDAV login</h2>
        <ul>
          <li>
            Address:{" "}
            <code>
              {(() => {
                const url = new URL(base);
                return !url.port || url.port === "443"
                  ? `https://dav.${url.hostname}`
                  : `${url.protocol}//${url.hostname}:8080`;
              })()}
            </code>
          </li>
          <li>
            User: <code>{process.env.WEBDAV_USER ?? "(not configured)"}</code>
          </li>
          <li>
            Password:{" "}
            {process.env.WEBDAV_PASS ? (
              <details className={styles.revealDetails}>
                <summary>reveal</summary>
                <code className={styles.token}>{process.env.WEBDAV_PASS}</code>
              </details>
            ) : (
              <code>(not configured)</code>
            )}
          </li>
        </ul>
      </section>

      <section className={styles.card}>
        <h2>Your capture token</h2>
        <p>
          <code className={styles.token}>{profile.captureToken}</code>
        </p>
        <p>
          Captures made with this token are attributed to{" "}
          <strong>{profile.displayName}</strong>. Keep it private; anyone with
          it can add papers as you.
        </p>
      </section>
    </main>
  );
}
