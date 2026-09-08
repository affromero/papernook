export type DocumentKind = "paper" | "conversation";

/** Safe, self-contained study HTML. No scripts or remote image dependencies. */
export interface OfflineChat {
  id: string;
  title: string;
  html: string;
}

export interface OfflineManifest {
  version: 1;
  owner: string;
  key: string;
  kind: DocumentKind;
  title: string;
  topic: string;
  tags: string[];
  onlineUrl: string;
  snapshotUrl: string;
  updatedAt: string;
  sourceHtml: string;
  summaryHtml: string;
  text: string;
  chats: OfflineChat[];
  /** Authenticated same-origin paper PDF endpoint, downloaded before commit. */
  pdfUrl?: string;
}

export interface OfflineRecord {
  manifest: OfflineManifest;
  pdf?: Blob;
  downloadedAt: string;
  bytes: number;
}

export interface OfflineIdentity {
  owner: string | null;
  generation: number;
}

export const OFFLINE_DB = "papernook-offline-v1";
export const OFFLINE_EVENT = "papernook-offline-change";
export const MAX_OFFLINE_BYTES = 160 * 1024 * 1024;
