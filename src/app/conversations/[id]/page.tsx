import { notFound, redirect } from "next/navigation";
import { activeProfile } from "@/lib/auth/session";
import {
  getConversation,
  listConversationChats,
} from "@/lib/conversations/store";
import { isValidSlug } from "@/lib/library/slug";
import { AccountBar } from "@/components/profiles/AccountBar";
import { ConversationReader } from "@/components/conversations/ConversationReader";
import styles from "@/components/conversations/ConversationReader.module.css";
import paperStyles from "@/app/paper/[topic]/[slug]/paper.module.css";
export const dynamic = "force-dynamic";
export default async function ConversationPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const profile = await activeProfile();
  if (!profile) redirect("/login");
  const { id } = await params;
  if (!isValidSlug(id)) notFound();
  const conversation = getConversation(profile.username, id);
  if (!conversation) notFound();
  return (
    <main className={`${paperStyles.root} ${styles.page}`}>
      <ConversationReader
        accountBar={
          <AccountBar
            displayName={profile.displayName}
            avatarSlug={profile.avatarSlug}
          />
        }
        conversation={conversation}
        initialChats={listConversationChats(profile.username, id)}
      />
    </main>
  );
}
