"use client";

import { useRouter } from "next/navigation";
import "thesidedoor/styles.css";
import { AccessSecurity } from "thesidedoor/react";
import styles from "./security/AccountSecurity.module.css";

export function AccountSecurity() {
  const router = useRouter();
  const classes = {
    root: styles.root,
    form: styles.form,
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
      copy={{ passwordManagerName: "Papernook" }}
      classes={classes}
      onSignInRequired={() => {
        router.push("/login");
        router.refresh();
      }}
      onHouseholdEntered={() => {
        router.push("/login");
        router.refresh();
      }}
    />
  );
}
