import Link from "next/link";
import { redirect } from "next/navigation";
import { activeProfile } from "@/lib/auth/session";
import { listConversations } from "@/lib/conversations/store";
import { AccountBar } from "@/components/profiles/AccountBar";
import { LibraryNavigation } from "@/components/conversations/LibraryNavigation";
import { ImportConversation } from "@/components/conversations/ImportConversation";
import styles from "@/components/conversations/ConversationView.module.css";
export const dynamic = "force-dynamic";
export default async function Conversations({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    topic?: string;
    tag?: string;
    import?: string;
  }>;
}) {
  const profile = await activeProfile();
  if (!profile) redirect("/login");
  const params = await searchParams;
  const all = listConversations(profile.username);
  const query = (params.q ?? "").toLowerCase();
  const records = all.filter(
    (record) =>
      (!params.topic || record.topic === params.topic) &&
      (!params.tag || record.tags.includes(params.tag)) &&
      (!query ||
        [
          record.title,
          record.topic,
          ...record.tags,
          ...record.messages.map((message) => message.content),
        ]
          .join(" ")
          .toLowerCase()
          .includes(query)),
  );
  return (
    <main>
      <AccountBar
        displayName={profile.displayName}
        avatarSlug={profile.avatarSlug}
      />
      <div className={styles.root}>
        <LibraryNavigation />
        <h1>
          Conversations <small>({all.length})</small>
        </h1>
        <p>
          Your imported source snapshots and follow-up chats are private to this
          profile.
        </p>
        <ImportConversation initialUrl={params.import} />
        <form className={styles.form}>
          <label>
            Search conversations
            <input name="q" defaultValue={params.q} />
          </label>
          <label>
            Topic
            <select name="topic" defaultValue={params.topic ?? ""}>
              <option value="">All topics</option>
              {[...new Set(all.map((record) => record.topic))]
                .sort()
                .map((topic) => (
                  <option key={topic}>{topic}</option>
                ))}
            </select>
          </label>
          <label>
            Tag
            <select name="tag" defaultValue={params.tag ?? ""}>
              <option value="">All tags</option>
              {[...new Set(all.flatMap((record) => record.tags))]
                .sort()
                .map((tag) => (
                  <option key={tag}>{tag}</option>
                ))}
            </select>
          </label>
          <button>Search</button>
        </form>
        {records.map((record) => (
          <article className={styles.card} key={record.id}>
            <h2>
              <Link href={`/conversations/${record.id}`}>{record.title}</Link>
            </h2>
            <p>
              {record.topic} · {record.provider} · {record.messages.length}{" "}
              messages
            </p>
            <p>{record.tags.join(", ")}</p>
          </article>
        ))}
        {records.length === 0 && <p>No conversations found.</p>}
      </div>
    </main>
  );
}
