import type { Metadata } from "next";
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

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const profile = await activeProfile();
  if (!profile) return { title: "papernook" };
  const { id } = await params;
  if (!isValidSlug(id)) return { title: "papernook" };
  const conversation = getConversation(profile.username, id);
  return { title: conversation?.title ?? "papernook" };
}

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
