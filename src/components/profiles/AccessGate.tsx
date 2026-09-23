"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { AccessForm, AccessInvitation } from "thesidedoor/react";
import type { AccessFormMode } from "thesidedoor/react";
import styles from "./ProfilePicker.module.css";

const accessChoices = [
  {
    mode: "household",
    label: "Open library",
    description: "Use the shared password, then choose your profile.",
  },
  {
    mode: "recover",
    label: "Recover access",
    description: "Use a recovery code if the shared password is lost.",
  },
  {
    mode: "claim",
    label: "Set up library",
    description: "For a new installation. Requires the owner-claim code.",
  },
] as const;

export function AccessGate({
  invitation = false,
  initialMode = "household",
}: {
  invitation?: boolean;
  initialMode?: AccessFormMode;
}) {
  const router = useRouter();
  const [mode, setMode] = useState<"household" | "claim" | "recover">(
    initialMode === "login" ? "household" : initialMode,
  );
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
      <h1 className={styles.heading}>
        {invitation ? "Join this library" : "Open your library"}
      </h1>
      {!invitation && (
        <p className={styles.accessIntro}>
          Enter with the library password. Everyone chooses their own profile
          next.
        </p>
      )}
      {invitation ? (
        <AccessInvitation
          endpoint="/api/v1/access"
          classes={classes}
          onSignedIn={signedIn}
        />
      ) : (
        <>
          <nav
            className={styles.accessModes}
            aria-label="How to enter the library"
          >
            {accessChoices.map((choice) => (
              <button
                key={choice.mode}
                type="button"
                className={`${styles.accessMode} ${mode === choice.mode ? styles.accessModeActive : ""}`}
                aria-pressed={mode === choice.mode}
                title={choice.description}
                onClick={() => setMode(choice.mode)}
              >
                <span className={styles.accessModeTitle}>{choice.label}</span>
                <span className={styles.accessModeHelp}>
                  {choice.description}
                </span>
              </button>
            ))}
          </nav>
          <AccessForm
            key={mode}
            endpoint="/api/v1/access"
            initialMode={mode}
            modes={[mode]}
            claimModes={["household"]}
            copy={{
              household: "Enter library",
              claim: "Claim library",
              recover: "Reset password",
              name: "First profile name",
              code: mode === "claim" ? "Owner-claim code" : "Recovery code",
              password:
                mode === "household"
                  ? "Library password"
                  : "New library password",
            }}
            classes={classes}
            onSignedIn={signedIn}
          />
        </>
      )}
    </div>
  );
}
