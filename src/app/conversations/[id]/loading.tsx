import styles from "@/components/conversations/ConversationView.module.css";

export default function LoadingConversation() {
  return (
    <main className={styles.root} aria-busy="true">
      <div className={styles.importProgress} role="status">
        <progress aria-label="Loading conversation" />
        <strong>Opening your conversation…</strong>
        <span>Preparing the saved messages for reading.</span>
      </div>
    </main>
  );
}
