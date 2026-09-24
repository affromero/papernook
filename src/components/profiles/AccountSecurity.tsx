"use client";

import { useRouter } from "next/navigation";
import "thesidedoor/styles.css";
import { AccessSecurity } from "thesidedoor/react";
import styles from "./ProfilePicker.module.css";

export function AccountSecurity() {
  const router = useRouter();
  const classes = {
    label: styles.fieldLabel,
    input: styles.nameInput,
    button: styles.primaryBtn,
    secondary: styles.ghostBtn,
    error: styles.error,
    hint: styles.gateHint,
  };
  return (
    <AccessSecurity
      endpoint="/api/v1/access"
      showRecoveryCodes={false}
      classes={classes}
      onSignInRequired={() => {
        router.push("/login");
        router.refresh();
      }}
    />
  );
}
