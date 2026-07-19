import { redirect } from "next/navigation";
import { headers } from "next/headers";
import Link from "next/link";
import { activeProfile } from "@/lib/auth/session";
import { isAdmin, listProfiles, toPublicProfile } from "@/lib/auth/users";
import { AccountBar } from "@/components/profiles/AccountBar";
import { AdminMembers } from "@/components/profiles/AdminMembers";
import { DeleteProfile } from "@/components/profiles/DeleteProfile";
import { InviteQr } from "@/components/profiles/InviteQr";
import { ModelPicker } from "@/components/profiles/ModelPicker";
import { ZoteroCard } from "@/components/profiles/ZoteroCard";
import { createInviteToken } from "@/lib/auth/gate";
import { instancePasswordConfigured } from "@/lib/auth/users";
import { optionalWebdavUrl } from "@/lib/webdav-url";
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
  const webdavUrl = optionalWebdavUrl(
    base,
    process.env.PAPERNOOK_WEBDAV_URL,
    process.env.WEBDAV_USER,
    process.env.WEBDAV_PASS,
  );

  return (
    <>
      <AccountBar
        displayName={profile.displayName}
        avatarSlug={profile.avatarSlug}
      />
      <main className={styles.root}>
        <header className={styles.pageHeader}>
          <div>
            <p className={styles.eyebrow}>Workspace controls</p>
            <h1>Settings</h1>
            <p className={styles.intro}>
              Capture tools, integrations, devices, and account access.
            </p>
          </div>
          <Link className={styles.dashboardLink} href="/">
            <span aria-hidden="true">←</span> Back to library
          </Link>
        </header>

        <div className={styles.layout}>
          <nav className={styles.sectionNav} aria-label="Settings sections">
            <p>On this page</p>
            <a href="#capture">Capture</a>
            <a href="#zotero">Zotero</a>
            {admin && <a href="#ai">AI model</a>}
            <a href="#people">People</a>
            <a href="#devices">Devices</a>
            <a href="#profile">My profile</a>
          </nav>

          <div className={styles.content}>
            <section className={styles.section} id="capture">
              <div className={styles.sectionHeader}>
                <span className={styles.sectionNumber}>01</span>
                <div>
                  <h2>Capture papers</h2>
                  <p>
                    Add the browser tool you use. Setup only takes a minute.
                  </p>
                </div>
              </div>

              <div className={styles.setupList}>
                <article className={styles.setupItem}>
                  <div className={styles.platform}>
                    <span className={styles.platformMark} aria-hidden="true">
                      C
                    </span>
                    <div>
                      <h3 className={styles.platformName}>Chrome</h3>
                      <p>Desktop bookmarklet</p>
                    </div>
                  </div>
                  <p className={styles.setupCopy}>
                    Drag the button to your bookmarks bar, then use it from any
                    paper page.
                  </p>
                  <a className={styles.primaryAction} href={bookmarklet}>
                    <span aria-hidden="true">＋</span> Add to papernook
                  </a>
                </article>

                <article className={styles.setupItem}>
                  <div className={styles.platform}>
                    <span className={styles.platformMark} aria-hidden="true">
                      S
                    </span>
                    <div>
                      <h3 className={styles.platformName}>Safari</h3>
                      <p>iPhone, iPad, and Mac</p>
                    </div>
                  </div>
                  <p className={styles.setupCopy}>
                    Add the Shortcut, enter this server when prompted, then
                    capture from the Share Sheet.
                  </p>
                  {shortcutShareUrl && (
                    <a className={styles.primaryAction} href={shortcutShareUrl}>
                      Get the Shortcut <span aria-hidden="true">↗</span>
                    </a>
                  )}
                  <p className={styles.serverHint}>
                    Server: <code>{base}</code>
                  </p>
                  <details className={styles.manualSetup}>
                    <summary>Build the Shortcut manually</summary>
                    <ol>
                      <li>
                        Add <strong>Receive input from Share Sheet</strong> with
                        the input type set to URLs.
                      </li>
                      <li>
                        Add <strong>Get Contents of URL</strong>. Use{" "}
                        <code>{shortcutUrl}</code>, method <code>POST</code>,
                        and a <code>Form</code> body with <code>url</code> set
                        to Shortcut Input and <code>token</code> set to the
                        token below.
                      </li>
                      <li>
                        Add <strong>Show Web Page</strong> with the result and
                        name the Shortcut &ldquo;Add to papernook&rdquo;.
                      </li>
                    </ol>
                  </details>
                </article>
              </div>

              <details className={styles.secretPanel}>
                <summary>Show my capture token</summary>
                <div>
                  <code className={styles.token}>{profile.captureToken}</code>
                  <p>
                    Private to {profile.displayName}. Anyone with this token can
                    add papers as you.
                  </p>
                </div>
              </details>
            </section>

            <section className={styles.section} id="zotero">
              <div className={styles.sectionHeader}>
                <span className={styles.sectionNumber}>02</span>
                <div>
                  <h2>Zotero</h2>
                  <p>Browse your library and import papers intentionally.</p>
                </div>
              </div>
              <ZoteroCard />
            </section>

            {admin && (
              <section className={styles.section} id="ai">
                <div className={styles.sectionHeader}>
                  <span className={styles.sectionNumber}>03</span>
                  <div>
                    <h2>AI model</h2>
                    <p>Choose how papernook analyzes and discusses papers.</p>
                  </div>
                </div>
                <ModelPicker />
              </section>
            )}

            <section className={styles.section} id="people">
              <div className={styles.sectionHeader}>
                <span className={styles.sectionNumber}>
                  {admin ? "04" : "03"}
                </span>
                <div>
                  <h2>People</h2>
                  <p>
                    The paper library is shared; chats and capture tools stay
                    private to each profile.
                  </p>
                </div>
              </div>

              {admin && (
                <div className={styles.subsection}>
                  <h3>Members</h3>
                  <p>
                    You manage instance configuration. Members choose their name
                    and avatar.
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
                </div>
              )}

              <div className={styles.subsection}>
                <h3>Invite someone</h3>
                {admin && instancePasswordConfigured() && (
                  <InviteQr
                    inviteUrl={`${base}/invite?t=${createInviteToken()}`}
                  />
                )}
                <p>
                  {admin
                    ? "Share the invite link or QR. Their private setup wizard starts when they add a profile."
                    : "Ask the admin for an invite link or the access password."}
                </p>
              </div>
            </section>

            <section className={styles.section} id="devices">
              <div className={styles.sectionHeader}>
                <span className={styles.sectionNumber}>
                  {admin ? "05" : "04"}
                </span>
                <div>
                  <h2>Devices</h2>
                  <p>Open the same reader and chat on every device.</p>
                </div>
              </div>

              <div className={styles.subsection}>
                <h3>Connect a phone or tablet</h3>
                <p>Scan while connected through Tailscale or the same Wi-Fi.</p>
                <DevicePanel url={base} />
              </div>

              {webdavUrl && (
                <details className={`${styles.subsection} ${styles.webdav}`}>
                  <summary>External PDF app compatibility</summary>
                  <p>
                    Optional WebDAV access for apps that edit the PDF directly.
                  </p>
                  <dl className={styles.credentials}>
                    <div>
                      <dt>Address</dt>
                      <dd>
                        <code>{webdavUrl}</code>
                      </dd>
                    </div>
                    <div>
                      <dt>User</dt>
                      <dd>
                        <code>{process.env.WEBDAV_USER}</code>
                      </dd>
                    </div>
                    <div>
                      <dt>Password</dt>
                      <dd>
                        <details className={styles.revealDetails}>
                          <summary>Reveal password</summary>
                          <code className={styles.token}>
                            {process.env.WEBDAV_PASS}
                          </code>
                        </details>
                      </dd>
                    </div>
                  </dl>
                </details>
              )}
            </section>

            <section className={styles.section} id="profile">
              <div className={styles.sectionHeader}>
                <span className={styles.sectionNumber}>
                  {admin ? "06" : "05"}
                </span>
                <div>
                  <h2>My profile</h2>
                  <p>Manage personal data for {profile.displayName}.</p>
                </div>
              </div>
              <div className={`${styles.subsection} ${styles.dangerZone}`}>
                <h3>Delete profile</h3>
                <p>Review exactly what will be removed before you confirm.</p>
                <DeleteProfile username={profile.username} />
              </div>
            </section>
          </div>
        </div>
      </main>
    </>
  );
}
