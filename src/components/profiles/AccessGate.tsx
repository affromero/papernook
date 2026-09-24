"use client";

import { useRouter } from "next/navigation";
import { AccessForm } from "thesidedoor/react";
import styles from "./ProfilePicker.module.css";

export function AccessGate() {
  const router = useRouter();
  const classes = {
    form: `${styles.panel} ${styles.accessPanel}`,
    navigation: styles.hiddenAccessNavigation,
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
      <h1 className={styles.heading}>Open your library</h1>
      <p className={styles.accessIntro}>
        Enter the shared password, then choose your profile.
      </p>
      <AccessForm
        endpoint="/api/v1/access"
        initialMode="household"
        modes={["household"]}
        claimModes={["household"]}
        copy={{ householdAccount: "Papernook" }}
        classes={classes}
        onSignedIn={signedIn}
      />
    </div>
  );
}
