import {
  MAX_OFFLINE_BYTES,
  type OfflineManifest,
  type OfflineRecord,
} from "./types";
import {
  getOfflineIdentity,
  listOffline,
  saveOffline,
  setOfflineIdentity,
} from "./storage";

export type Connection =
  | { state: "online"; owner: string }
  | { state: "offline" | "signed-out" | "busy" };

export async function probeConnection(): Promise<Connection> {
  try {
    const response = await fetch("/api/v1/session", {
      cache: "no-store",
      credentials: "include",
      signal: AbortSignal.timeout(5000),
    });
    if (response.status === 401 || response.status === 403)
      return { state: "signed-out" };
    if (response.status === 429) return { state: "busy" };
    if (response.status >= 500) return { state: "offline" };
    if (!response.ok) return { state: "busy" };
    const body = await response.json();
    const owner: unknown = body?.profile?.username;
    return typeof owner === "string" && /^[a-z0-9][a-z0-9-]{0,79}$/.test(owner)
      ? { state: "online", owner }
      : { state: "signed-out" };
  } catch {
    return { state: "offline" };
  }
}

function localUrl(value: string, prefix: string): boolean {
  return (
    value.startsWith(prefix) &&
    !value.includes("\\") &&
    !value.includes("..") &&
    new URL(value, location.origin).origin === location.origin
  );
}

export function validManifest(value: unknown): value is OfflineManifest {
  if (!value || typeof value !== "object") return false;
  const item = value as OfflineManifest;
  return (
    item.version === 1 &&
    ["paper", "conversation"].includes(item.kind) &&
    typeof item.owner === "string" &&
    typeof item.key === "string" &&
    typeof item.title === "string" &&
    typeof item.topic === "string" &&
    typeof item.updatedAt === "string" &&
    typeof item.text === "string" &&
    typeof item.sourceHtml === "string" &&
    typeof item.summaryHtml === "string" &&
    Array.isArray(item.tags) &&
    item.tags.every((tag) => typeof tag === "string") &&
    Array.isArray(item.chats) &&
    item.chats.every(
      (chat) =>
        chat &&
        typeof chat.id === "string" &&
        typeof chat.title === "string" &&
        typeof chat.html === "string",
    ) &&
    typeof item.onlineUrl === "string" &&
    localUrl(
      item.onlineUrl,
      item.kind === "paper" ? "/paper/" : "/conversations/",
    ) &&
    typeof item.snapshotUrl === "string" &&
    localUrl(item.snapshotUrl, "/api/v1/offline/") &&
    (item.kind !== "paper" || typeof item.pdfUrl === "string") &&
    (item.pdfUrl === undefined ||
      (typeof item.pdfUrl === "string" &&
        localUrl(item.pdfUrl, "/api/v1/papers/")))
  );
}

async function boundedBlob(response: Response, max: number): Promise<Blob> {
  if (Number(response.headers.get("content-length")) > max) {
    await response.body?.cancel();
    throw new Error("This download exceeds the device download size limit.");
  }
  if (!response.body) throw new Error("The server returned an empty download.");
  const reader = response.body.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max)
        throw new Error(
          "This download exceeds the device download size limit.",
        );
      chunks.push(new Uint8Array(value));
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  return new Blob(chunks, {
    type: response.headers.get("content-type") ?? "application/octet-stream",
  });
}

const pending = new Map<string, Promise<OfflineRecord>>();

export function downloadOffline(snapshotUrl: string): Promise<OfflineRecord> {
  const previous = pending.get(snapshotUrl);
  if (previous) return previous;
  if (pending.size >= 2)
    return Promise.reject(
      new Error("Wait for the current downloads to finish."),
    );
  const operation = performDownload(snapshotUrl).finally(() =>
    pending.delete(snapshotUrl),
  );
  pending.set(snapshotUrl, operation);
  return operation;
}

async function performDownload(snapshotUrl: string): Promise<OfflineRecord> {
  if (!localUrl(snapshotUrl, "/api/v1/offline/"))
    throw new Error("Invalid download address.");
  const initialIdentity = await getOfflineIdentity();
  const connection = await probeConnection();
  if (connection.state !== "online")
    throw new Error("Connect and sign in to download this document.");
  if (initialIdentity.owner && initialIdentity.owner !== connection.owner)
    throw new Error("The active profile changed. Reload before downloading.");
  const identity = initialIdentity.owner
    ? initialIdentity
    : { owner: connection.owner, generation: initialIdentity.generation + 1 };
  await setOfflineIdentity(connection.owner, initialIdentity);
  const response = await fetch(snapshotUrl, {
    cache: "no-store",
    credentials: "include",
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => null);
    throw new Error(error?.error ?? `Download failed (${response.status}).`);
  }
  if (!response.headers.get("content-type")?.includes("application/json"))
    throw new Error("The server did not return a study download.");
  const data = await boundedBlob(response, MAX_OFFLINE_BYTES);
  const manifest: unknown = JSON.parse(await data.text());
  if (
    !validManifest(manifest) ||
    manifest.owner !== identity.owner ||
    manifest.snapshotUrl !== snapshotUrl
  )
    throw new Error(
      "The download does not belong to the active profile or document.",
    );
  let pdf: Blob | undefined;
  if (manifest.pdfUrl) {
    const pdfResponse = await fetch(manifest.pdfUrl, {
      cache: "no-store",
      credentials: "include",
      signal: AbortSignal.timeout(120_000),
    });
    if (
      !pdfResponse.ok ||
      !pdfResponse.headers.get("content-type")?.includes("application/pdf")
    )
      throw new Error(
        "The paper PDF could not be downloaded. Your previous download is unchanged.",
      );
    pdf = await boundedBlob(pdfResponse, MAX_OFFLINE_BYTES - data.size);
    if (!(await pdf.slice(0, 5).text()).startsWith("%PDF-"))
      throw new Error("The server returned an invalid PDF.");
  }
  const current = await probeConnection();
  if (current.state !== "online" || current.owner !== identity.owner)
    throw new Error(
      "The profile or connection changed before the download finished.",
    );
  const record: OfflineRecord = {
    manifest,
    pdf,
    downloadedAt: new Date().toISOString(),
    bytes: new Blob([JSON.stringify(manifest)]).size + (pdf?.size ?? 0),
  };
  await saveOffline(record, identity);
  return record;
}

export async function refreshOffline(): Promise<void> {
  for (const item of await listOffline()) {
    if (Date.now() - Date.parse(item.downloadedAt) < 15 * 60_000) continue;
    await downloadOffline(item.manifest.snapshotUrl);
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
