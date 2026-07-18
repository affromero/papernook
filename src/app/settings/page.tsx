import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { activeProfile } from "@/lib/auth/session";
import { DevicePanel } from "@/components/pwa/DevicePanel";
import styles from "./settings.module.css";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const profile = await activeProfile();
  if (!profile) redirect("/login");

  const headerStore = await headers();
  const host = headerStore.get("host") ?? "localhost:3000";
  const proto = headerStore.get("x-forwarded-proto") ?? "http";
  const base = `${proto}://${host}`;
  const bookmarklet = `javascript:location.href='${base}/add?token=${profile.captureToken}&url='+encodeURIComponent(location.href)`;
  const shortcutUrl = `${base}/add`;

  return (
    <main className={styles.root}>
      <h1>Settings — capture</h1>

      <section className={styles.card}>
        <h2>Chrome (desktop): bookmarklet</h2>
        <p>
          Drag this link to your bookmarks bar. On any paper page, click it —
          you land on the confirmation page.
        </p>
        <a className={styles.bookmarklet} href={bookmarklet}>
          📚 Add to papernook
        </a>
      </section>

      <section className={styles.card}>
        <h2>Safari (iPhone / iPad / Mac): Shortcut</h2>
        <p>Create a Shortcut once — three steps in the Shortcuts app:</p>
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
            Add <strong>Show Web Page</strong> with the result — name it
            &ldquo;Add to papernook&rdquo;.
          </li>
        </ol>
        <p>Then on any paper page: Share → Add to papernook → confirm. Done.</p>
      </section>

      <section className={styles.card}>
        <h2>Invite a friend</h2>
        <ol>
          <li>
            Give them access: a Tailscale invite to this network (private mode),
            or the public URL if this server is exposed — they will set a
            password on first login.
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
        <DevicePanel />
      </section>

      <section className={styles.card}>
        <h2>Your capture token</h2>
        <p>
          <code className={styles.token}>{profile.captureToken}</code>
        </p>
        <p>
          Captures made with this token are attributed to{" "}
          <strong>{profile.displayName}</strong>. Keep it private — anyone with
          it can add papers as you.
        </p>
      </section>
    </main>
  );
}
