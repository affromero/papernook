import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

class BrowserFileReader {
  result: string | null = null;
  onload?: () => void;
  onerror?: () => void;
  onabort?: () => void;
  readAsDataURL(blob: Blob): void {
    void blob.arrayBuffer().then((bytes) => {
      this.result = `data:${blob.type};base64,${Buffer.from(bytes).toString("base64")}`;
      this.onload?.();
    });
  }
}

interface Incoming {
  url: string;
  signal: AbortSignal;
  response: ReturnType<typeof Promise.withResolvers<Response>>;
}

let incoming: Incoming[];
const image = () =>
  new Response("image bytes", { headers: { "Content-Type": "image/png" } });

beforeEach(() => {
  vi.resetModules();
  incoming = [];
  vi.stubGlobal("FileReader", BrowserFileReader);
  vi.stubGlobal("fetch", (url: string, options: RequestInit) => {
    const response = Promise.withResolvers<Response>();
    incoming.push({ url, signal: options.signal!, response });
    return response.promise;
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("automatic site icons", () => {
  it("shares an unfinished lookup while another reader still needs it", async () => {
    const { requestSiteIcon } =
      await import("@/components/chat/shared-layout/site-icon-queue");
    const first = requestSiteIcon("https://example.com");
    const second = requestSiteIcon("https://example.com");
    first.cancel();
    expect(incoming).toHaveLength(1);
    expect(incoming[0].signal.aborted).toBe(false);
    incoming[0].response.resolve(image());
    expect(await second.result).toBe("data:image/png;base64,aW1hZ2UgYnl0ZXM=");
    second.cancel();
  });

  it("starts at most two HTTP lookups and serves queued readers afterward", async () => {
    const { requestSiteIcon } =
      await import("@/components/chat/shared-layout/site-icon-queue");
    const subscriptions = ["one", "two", "three", "four"].map((name) =>
      requestSiteIcon(`https://${name}.example.com`),
    );
    expect(incoming).toHaveLength(2);
    incoming[0].response.resolve(image());
    incoming[1].response.resolve(image());
    await Promise.all(subscriptions.slice(0, 2).map((item) => item.result));
    await vi.waitFor(() => expect(incoming).toHaveLength(4));
    incoming[2].response.resolve(image());
    incoming[3].response.resolve(image());
    expect(await Promise.all(subscriptions.map((item) => item.result))).toEqual(
      Array(4).fill("data:image/png;base64,aW1hZ2UgYnl0ZXM="),
    );
    subscriptions.forEach((item) => item.cancel());
  });

  it("keeps an aborted request's slot until it settles and admits a fresh subscriber", async () => {
    const { requestSiteIcon } =
      await import("@/components/chat/shared-layout/site-icon-queue");
    const abandoned = requestSiteIcon("https://example.com");
    const cancelled = expect(abandoned.result).rejects.toThrow();
    abandoned.cancel();
    expect(incoming[0].signal.aborted).toBe(true);
    const replacement = requestSiteIcon("https://example.com");
    const queued = requestSiteIcon("https://other.example.com");
    expect(incoming).toHaveLength(2);
    incoming[0].response.reject(new DOMException("Aborted", "AbortError"));
    await cancelled;
    await vi.waitFor(() => expect(incoming).toHaveLength(3));
    const duplicate = requestSiteIcon("https://example.com");
    expect(incoming).toHaveLength(3);
    incoming[1].response.resolve(image());
    incoming[2].response.resolve(image());
    await Promise.all([replacement.result, duplicate.result, queued.result]);
    replacement.cancel();
    duplicate.cancel();
    queued.cancel();
  });

  it("does not fetch a queued icon whose last reader left", async () => {
    const { requestSiteIcon } =
      await import("@/components/chat/shared-layout/site-icon-queue");
    const first = requestSiteIcon("https://one.example.com");
    const second = requestSiteIcon("https://two.example.com");
    const queued = requestSiteIcon("https://cancelled.example.com");
    const cancelled = expect(queued.result).rejects.toThrow();
    queued.cancel();
    await cancelled;
    incoming.forEach((request) => request.response.resolve(image()));
    await Promise.all([first.result, second.result]);
    expect(incoming.map((request) => request.url)).not.toContain(
      expect.stringContaining("cancelled.example.com"),
    );
    first.cancel();
    second.cancel();
  });

  it("surfaces an HTTP failure and permits an explicit fresh retry", async () => {
    const { requestSiteIcon } =
      await import("@/components/chat/shared-layout/site-icon-queue");
    const first = requestSiteIcon("https://example.com");
    incoming[0].response.resolve(new Response("Unavailable", { status: 429 }));
    await expect(first.result).rejects.toThrow(/could not be loaded/);
    const retry = requestSiteIcon("https://example.com");
    expect(incoming).toHaveLength(2);
    incoming[1].response.resolve(image());
    expect(await retry.result).toContain("data:image/png;base64,");
    first.cancel();
    retry.cancel();
  });
});
