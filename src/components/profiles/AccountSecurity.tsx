"use client";

import { useRouter } from "next/navigation";
import "thesidedoor/styles.css";
import { AccessSecurity, AccessInviteLink } from "thesidedoor/react";
import styles from "./ProfilePicker.module.css";

export function AccountSecurity({
  invitations = false,
}: {
  invitations?: boolean;
}) {
  const router = useRouter();
  const classes = {
    label: styles.fieldLabel,
    input: styles.nameInput,
    button: styles.primaryBtn,
    secondary: styles.ghostBtn,
    error: styles.error,
    hint: styles.gateHint,
  };
  return invitations ? (
    <AccessInviteLink endpoint="/api/v1/access" classes={classes} />
  ) : (
    <AccessSecurity
      endpoint="/api/v1/access"
      classes={classes}
      onSignInRequired={() => {
        router.push("/login?account=1");
        router.refresh();
      }}
    />
  );
}
