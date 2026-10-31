import { siteIconSite } from "@/lib/chat/layout/site-icon";

interface RequestEntry {
  origin: string;
  controller: AbortController;
  subscribers: number;
  started: boolean;
  result: Promise<string>;
  resolve(value: string): void;
  reject(reason: unknown): void;
}

const requests = new Map<string, RequestEntry>();
const pending: RequestEntry[] = [];
let active = 0;

async function imageData(entry: RequestEntry): Promise<string> {
  const timeout = setTimeout(() => entry.controller.abort(), 16_000);
  try {
    const response = await fetch(
      `/api/v1/site-icon?url=${encodeURIComponent(entry.origin)}`,
      {
        credentials: "same-origin",
        referrerPolicy: "no-referrer",
        signal: entry.controller.signal,
      },
    );
    const mime = response.headers.get("content-type")?.split(";")[0].trim();
    if (
      !response.ok ||
      !/^image\/(png|jpeg|gif|webp|x-icon|vnd\.microsoft\.icon|svg\+xml)$/.test(
        mime ?? "",
      ) ||
      Number(response.headers.get("content-length")) > 2 * 1024 * 1024
    ) {
      await response.body?.cancel();
      throw new Error("Site icon could not be loaded. Try again.");
    }
    const blob = await response.blob();
    if (!blob.size || blob.size > 2 * 1024 * 1024)
      throw new Error("Site icon exceeds the image limit or is empty.");
    entry.controller.signal.throwIfAborted();
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () =>
        !entry.controller.signal.aborted && typeof reader.result === "string"
          ? resolve(reader.result)
          : reject(new Error("Site icon could not be read."));
      reader.onerror = () => reject(new Error("Site icon could not be read."));
      reader.onabort = () =>
        reject(new Error("Site icon loading was cancelled."));
      reader.readAsDataURL(blob);
    });
  } finally {
    clearTimeout(timeout);
  }
}

function pump(): void {
  while (active < 2 && pending.length) {
    const entry = pending.shift()!;
    if (entry.controller.signal.aborted) continue;
    entry.started = true;
    active++;
    void imageData(entry)
      .finally(() => {
        active--;
        if (requests.get(entry.origin) === entry) requests.delete(entry.origin);
        pump();
      })
      .then(entry.resolve, entry.reject);
  }
}

/** Share only unfinished lookups. Cancellation keeps the slot until fetch settles. */
export function requestSiteIcon(origin: string): {
  result: Promise<string>;
  cancel(): void;
} {
  const site = siteIconSite(origin);
  if (!site || site.origin !== origin) throw new Error("Invalid site origin.");
  let entry = requests.get(origin);
  if (!entry || entry.controller.signal.aborted) {
    let resolve!: RequestEntry["resolve"];
    let reject!: RequestEntry["reject"];
    const result = new Promise<string>((complete, fail) => {
      resolve = complete;
      reject = fail;
    });
    entry = {
      origin,
      controller: new AbortController(),
      subscribers: 0,
      started: false,
      result,
      resolve,
      reject,
    };
    requests.set(origin, entry);
    pending.push(entry);
  }
  entry.subscribers++;
  const subscribed = entry;
  let cancelled = false;
  pump();
  return {
    result: subscribed.result,
    cancel() {
      if (cancelled) return;
      cancelled = true;
      if (--subscribed.subscribers) return;
      subscribed.controller.abort();
      if (!subscribed.started) {
        subscribed.reject(new Error("Site icon loading was cancelled."));
        if (requests.get(origin) === subscribed) requests.delete(origin);
      }
    },
  };
}
