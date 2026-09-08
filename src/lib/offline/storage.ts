import {
  OFFLINE_DB,
  OFFLINE_EVENT,
  type OfflineIdentity,
  type OfflineRecord,
} from "./types";

let database: Promise<IDBDatabase> | undefined;
const emptyIdentity = (): OfflineIdentity => ({ owner: null, generation: 0 });
const REVOCATION_KEY = "papernook:offline-revoked";
const REVOCATION_COOKIE = "papernook_offline_revoked";

export class OfflineIdentityChangedError extends Error {}

/** Binary buffers also persist in WebKit contexts that reject Blob records. */
type StoredRecord = Omit<OfflineRecord, "pdf"> & { pdfBytes?: ArrayBuffer };

function hydrate(record: StoredRecord): OfflineRecord {
  const { pdfBytes, ...rest } = record;
  return pdfBytes
    ? { ...rest, pdf: new Blob([pdfBytes], { type: "application/pdf" }) }
    : rest;
}

function revocation(): string | null {
  try {
    const value = globalThis.localStorage?.getItem(REVOCATION_KEY);
    if (value) return value;
  } catch {
    /* Cookies also retain revocation when local storage is denied. */
  }
  try {
    if (typeof document !== "undefined") {
      const value = document.cookie
        .split("; ")
        .find((part) => part.startsWith(`${REVOCATION_COOKIE}=`));
      if (value) return value.slice(REVOCATION_COOKIE.length + 1);
    }
  } catch {
    /* Cookie access may also be denied by browser policy. */
  }
  return null;
}

function markRevoked(): void {
  const value = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    globalThis.localStorage?.setItem(REVOCATION_KEY, value);
  } catch {
    /* Cookie below is the secondary durable marker. */
  }
  try {
    if (typeof document !== "undefined")
      document.cookie = `${REVOCATION_COOKIE}=${value}; Path=/; Max-Age=31536000; SameSite=Strict`;
  } catch {
    /* Local storage retains revocation when cookies are denied. */
  }
  notify();
}

function clearRevocation(): void {
  try {
    globalThis.localStorage?.removeItem(REVOCATION_KEY);
  } catch {
    /* A remaining marker safely keeps offline storage locked. */
  }
  try {
    if (typeof document !== "undefined")
      document.cookie = `${REVOCATION_COOKIE}=; Path=/; Max-Age=0; SameSite=Strict`;
  } catch {
    /* Keep the remaining marker locked. */
  }
}

/** Online authentication remains available when IndexedDB is denied. */
export async function clearOfflineForAuthentication(): Promise<void> {
  markRevoked();
  try {
    await setOfflineIdentity(null);
  } catch {
    /* Revocation blocks old downloads even if their disk purge is unavailable. */
  }
}

function openDatabase(): Promise<IDBDatabase> {
  if (!database) {
    database = new Promise((resolve, reject) => {
      if (!globalThis.indexedDB) {
        reject(new Error("This browser does not support offline storage."));
        return;
      }
      const request = indexedDB.open(OFFLINE_DB, 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore("identity");
        request.result.createObjectStore("documents", {
          keyPath: "manifest.key",
        });
      };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        request.result.onversionchange = () => {
          request.result.close();
          database = undefined;
        };
        resolve(request.result);
      };
      request.onblocked = () =>
        reject(
          new Error("Close other Papernook tabs to update offline storage."),
        );
    });
    database.catch(() => {
      database = undefined;
    });
  }
  return database;
}

function result<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function completed(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () =>
      reject(
        transaction.error ??
          new Error("Offline storage transaction was cancelled."),
      );
    transaction.onerror = () => reject(transaction.error);
  });
}

function notify(): void {
  globalThis.dispatchEvent(new Event(OFFLINE_EVENT));
  if (typeof BroadcastChannel !== "undefined") {
    const channel = new BroadcastChannel(OFFLINE_EVENT);
    channel.postMessage("changed");
    channel.close();
  }
}

export function subscribeOffline(listener: () => void): () => void {
  globalThis.addEventListener(OFFLINE_EVENT, listener);
  const storageChanged = (event: Event) => {
    if ((event as StorageEvent).key === REVOCATION_KEY) listener();
  };
  globalThis.addEventListener("storage", storageChanged);
  const channel =
    typeof BroadcastChannel !== "undefined"
      ? new BroadcastChannel(OFFLINE_EVENT)
      : null;
  if (channel) channel.onmessage = listener;
  return () => {
    globalThis.removeEventListener(OFFLINE_EVENT, listener);
    globalThis.removeEventListener("storage", storageChanged);
    channel?.close();
  };
}

export async function getOfflineIdentity(): Promise<OfflineIdentity> {
  const db = await openDatabase();
  const identity: OfflineIdentity =
    (await result(
      db.transaction("identity").objectStore("identity").get("active"),
    )) ?? emptyIdentity();
  return revocation() ? { ...identity, owner: null } : identity;
}

/** An identity change and its private-data purge are a single transaction. */
export async function setOfflineIdentity(
  owner: string | null,
  expected?: OfflineIdentity,
): Promise<void> {
  const marker = revocation();
  const db = await openDatabase();
  const tx = db.transaction(["identity", "documents"], "readwrite");
  const done = completed(tx);
  const identities = tx.objectStore("identity");
  const request = identities.get("active");
  let changed = false;
  let stale = false;
  request.onsuccess = () => {
    const previous: OfflineIdentity = request.result ?? emptyIdentity();
    if (
      expected &&
      (previous.owner !== expected.owner ||
        previous.generation !== expected.generation)
    ) {
      stale = true;
      return;
    }
    if (revocation() !== marker) {
      stale = true;
      return;
    }
    if (previous.owner === owner) return;
    changed = true;
    tx.objectStore("documents").clear();
    identities.put({ owner, generation: previous.generation + 1 }, "active");
  };
  await done;
  if (stale)
    throw new OfflineIdentityChangedError(
      "The active profile changed during this operation. Try again.",
    );
  if (owner && revocation() === marker) clearRevocation();
  if (changed || marker) notify();
}

export async function listOffline(): Promise<OfflineRecord[]> {
  if (revocation()) return [];
  const db = await openDatabase();
  const tx = db.transaction(["identity", "documents"]);
  const [identity, records] = await Promise.all([
    result<OfflineIdentity | undefined>(
      tx.objectStore("identity").get("active"),
    ),
    result<StoredRecord[]>(tx.objectStore("documents").getAll()),
  ]);
  return revocation()
    ? []
    : records
        .filter(
          (record) =>
            identity?.owner && record.manifest.owner === identity.owner,
        )
        .map(hydrate);
}

export async function readOffline(key: string): Promise<OfflineRecord | null> {
  if (revocation()) return null;
  const db = await openDatabase();
  const tx = db.transaction(["identity", "documents"]);
  const [identity, record] = await Promise.all([
    result<OfflineIdentity | undefined>(
      tx.objectStore("identity").get("active"),
    ),
    result<StoredRecord | undefined>(tx.objectStore("documents").get(key)),
  ]);
  return !revocation() &&
    record &&
    identity?.owner &&
    record.manifest.owner === identity.owner
    ? hydrate(record)
    : null;
}

export async function saveOffline(
  record: OfflineRecord,
  expected: OfflineIdentity,
): Promise<void> {
  const { pdf, ...rest } = record;
  const stored: StoredRecord = pdf
    ? { ...rest, pdfBytes: await pdf.arrayBuffer() }
    : rest;
  const db = await openDatabase();
  const tx = db.transaction(["identity", "documents"], "readwrite");
  const done = completed(tx);
  let invalidated = false;
  const request = tx.objectStore("identity").get("active");
  request.onsuccess = () => {
    const current: OfflineIdentity = request.result ?? emptyIdentity();
    if (
      revocation() ||
      !current.owner ||
      current.owner !== record.manifest.owner ||
      current.owner !== expected.owner ||
      current.generation !== expected.generation
    ) {
      invalidated = true;
      return;
    }
    tx.objectStore("documents").put(stored);
  };
  await done;
  if (invalidated)
    throw new Error(
      "Download cancelled because offline storage or the profile changed.",
    );
  notify();
}

/** Incrementing the generation also cancels downloads running in other tabs. */
export async function removeOffline(key?: string): Promise<void> {
  const db = await openDatabase();
  const tx = db.transaction(["identity", "documents"], "readwrite");
  const done = completed(tx);
  const identities = tx.objectStore("identity");
  const request = identities.get("active");
  request.onsuccess = () => {
    const previous: OfflineIdentity = request.result ?? emptyIdentity();
    identities.put(
      { ...previous, generation: previous.generation + 1 },
      "active",
    );
    if (key) tx.objectStore("documents").delete(key);
    else tx.objectStore("documents").clear();
  };
  await done;
  notify();
}

export function offlineError(error: unknown): string {
  if (error instanceof DOMException && error.name === "QuotaExceededError") {
    return "Your device has insufficient storage. Remove some downloads in Settings and try again.";
  }
  return error instanceof Error
    ? error.message
    : "Offline storage is unavailable in this browser.";
}
