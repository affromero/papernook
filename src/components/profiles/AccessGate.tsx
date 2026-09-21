"use client";

import { useRouter } from "next/navigation";
import { AccessForm, AccessInvitation } from "thesidedoor/react";
import type { AccessFormMode } from "thesidedoor/react";
import styles from "./ProfilePicker.module.css";

export function AccessGate({
  invitation = false,
  initialMode = "household",
}: {
  invitation?: boolean;
  initialMode?: AccessFormMode;
}) {
  const router = useRouter();
  const classes = {
    form: styles.panel,
    navigation: styles.panelActions,
    label: styles.fieldLabel,
    input: styles.nameInput,
    button: styles.primaryBtn,
    secondary: styles.ghostBtn,
    error: styles.error,
    hint: styles.gateHint,
  };
  function signedIn(session: { principal: unknown }) {
    router.replace(session.principal ? "/" : "/login");
    router.refresh();
  }
  return (
    <div className={styles.root}>
      <div className={styles.brand}>papernook</div>
      <h1 className={styles.heading}>
        {invitation ? "Join this library" : "Open your library"}
      </h1>
      {invitation ? (
        <AccessInvitation
          endpoint="/api/v1/access"
          classes={classes}
          onSignedIn={signedIn}
        />
      ) : (
        <AccessForm
          endpoint="/api/v1/access"
          initialMode={initialMode}
          classes={classes}
          onSignedIn={signedIn}
        />
      )}
    </div>
  );
}
