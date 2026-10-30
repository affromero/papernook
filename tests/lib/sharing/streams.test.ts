import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

let directory: string;
beforeEach(() => {
  directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "papernook-sharing-stream-"),
  );
  vi.stubEnv("PAPERNOOK_DATA_DIR", directory);
  vi.resetModules();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  fs.rmSync(directory, { recursive: true, force: true });
});

it("keeps response admission until the final blocked transport write drains", async () => {
  const { withSharingResponse } = await import("@/lib/sharing/storage");
  const expected = Buffer.alloc(128 * 1024, 7);
  const response = await withSharingResponse(
    async () => new Response(expected, { headers: { etag: '"example"' } }),
  );
  const other = await withSharingResponse(
    async () => new Response("another admitted response"),
  );
  const blocked = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const piping = response.body!.pipeTo(
    new WritableStream<Uint8Array>({
      async write(chunk) {
        chunks.push(chunk);
        size += chunk.byteLength;
        expect(chunk.buffer.byteLength).toBeLessThanOrEqual(64 * 1024);
        if (size === expected.byteLength) {
          blocked.resolve();
          await resume.promise;
        }
      },
    }),
  );
  await blocked.promise;
  await expect(
    withSharingResponse(async () => new Response("too many")),
  ).rejects.toMatchObject({ status: 429 });
  resume.resolve();
  await piping;
  expect(Buffer.concat(chunks)).toEqual(expected);
  expect(response.headers.get("etag")).toBe('"example"');
  const next = await withSharingResponse(
    async () => new Response("now admitted"),
  );
  expect(await next.text()).toBe("now admitted");
  await other.body!.cancel();
});

it("expires stalled responses without retaining a large buffer in the blocked sink", async () => {
  vi.useFakeTimers();
  const { withSharingResponse } = await import("@/lib/sharing/storage");
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(256 * 1024));
    },
    cancel() {
      cancelled = true;
    },
  });
  const response = await withSharingResponse(async () => new Response(body));
  const other = await withSharingResponse(async () => new Response("second"));
  const blocked = Promise.withResolvers<Uint8Array>();
  const resume = Promise.withResolvers<void>();
  let ended = false;
  const piping = response
    .body!.pipeTo(
      new WritableStream<Uint8Array>({
        async write(chunk) {
          blocked.resolve(chunk);
          await resume.promise;
        },
      }),
    )
    .then(
      () => {
        ended = true;
        return null;
      },
      (error: unknown) => {
        ended = true;
        return error;
      },
    );
  const retained = await blocked.promise;
  expect(retained.byteLength).toBe(64 * 1024);
  expect(retained.buffer.byteLength).toBe(64 * 1024);
  await vi.advanceTimersByTimeAsync(60_001);
  expect(cancelled).toBe(true);
  expect(ended).toBe(false);
  const next = await withSharingResponse(
    async () => new Response("released after expiry"),
  );
  expect(await next.text()).toBe("released after expiry");
  resume.resolve();
  expect(await piping).toBeInstanceOf(Error);
  await other.body!.cancel().catch(() => undefined);
});

it("releases response slots on cancellation, errors, and bodyless replies", async () => {
  const { withSharingResponse } = await import("@/lib/sharing/storage");
  const first = await withSharingResponse(async () => new Response("first"));
  const second = await withSharingResponse(async () => new Response("second"));
  await first.body!.cancel();
  const empty = await withSharingResponse(
    async () => new Response(null, { status: 204 }),
  );
  expect(empty.status).toBe(204);
  await expect(
    withSharingResponse(async () => {
      throw new Error("failed operation");
    }),
  ).rejects.toThrow("failed operation");
  const rejected = await withSharingResponse(async () =>
    Response.json({ error: "denied" }, { status: 403 }),
  );
  expect(rejected.status).toBe(403);
  const next = await withSharingResponse(
    async () => new Response("slot remains available"),
  );
  expect(await next.text()).toBe("slot remains available");
  await second.body!.cancel();
});
