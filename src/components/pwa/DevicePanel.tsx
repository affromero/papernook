"use client";

import "thesidedoor/styles.css";
import { ConnectPanel } from "thesidedoor/react";

/**
 * sidedoor's connect panel: resolves the private reach URL (Tailscale
 * first), shows the QR, and walks Add to Home Screen on the iPad/phone.
 */
export function DevicePanel({ url }: { url?: string }) {
  return <ConnectPanel appName="papernook" url={url} port="3000" />;
}
