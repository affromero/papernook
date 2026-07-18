"use client";

import "thesidedoor/styles.css";
import { QrCode } from "thesidedoor/react";
import styles from "./InviteQr.module.css";

/**
 * Admin invite: a signed 7-day link that opens the gate without typing the
 * password. Scan the QR or send the link; the invitee lands on the picker.
 */
export function InviteQr({ inviteUrl }: { inviteUrl: string }) {
  return (
    <div className={styles.root}>
      <QrCode value={inviteUrl} />
      <p className={styles.link}>
        <code>{inviteUrl}</code>
      </p>
      <p className={styles.note}>
        Valid for 7 days. Anyone with it skips the password prompt, so share it
        like you would share the password itself.
      </p>
    </div>
  );
}
