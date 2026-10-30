import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Response as RemoteResponse } from "undici";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GET } from "@/app/api/v1/site-icon/route";
import {
  loadSiteIcon,
  SiteIconBusyError,
} from "@/lib/conversations/icons/site-icon";
import { createTestProfile, testSession } from "../../helpers/access";

const boundary = vi.hoisted(() => ({ token: "", fetch: vi.fn() }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: () => (boundary.token ? { value: boundary.token } : undefined),
  }),
}));
vi.mock("node:dns/promises", () => ({
  lookup: async () => [{ address: "8.8.8.8", family: 4 }],
}));
vi.mock("node:timers/promises", async (original) => ({
  ...(await original<typeof import("node:timers/promises")>()),
  setTimeout: async () => undefined,
}));
vi.mock("undici", async (original) => ({
  ...(await original<typeof import("undici")>()),
  fetch: boundary.fetch,
}));

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6i0AAAAASUVORK5CYII=",
  "base64",
);
let directory: string;
const routes = new Map<
  string,
  () => RemoteResponse | Promise<RemoteResponse>
>();
const requests: { url: string; headers: Record<string, string> }[] = [];
beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "site-icons-"));
  vi.stubEnv("PAPERNOOK_DATA_DIR", directory);
  await createTestProfile("Alice");
  boundary.token = await testSession("alice");
  routes.clear();
  requests.length = 0;
  boundary.fetch.mockReset();
  boundary.fetch.mockImplementation(
    (url: string, options: { headers: Record<string, string> }) => {
      requests.push({ url, headers: options.headers });
      const response = routes.get(url);
      if (!response) throw new Error(`Unexpected external request: ${url}`);
      return response();
    },
  );
});
afterEach(() => {
  boundary.token = "";
  vi.unstubAllEnvs();
  fs.rmSync(directory, { recursive: true, force: true });
});
function get(origin = "https://example.com") {
  return GET(
    new Request(
      `http://localhost/api/v1/site-icon?url=${encodeURIComponent(origin)}`,
      { headers: { Cookie: "private=secret" } },
    ),
  );
}
function page(html: string) {
  routes.set(
    "https://example.com/",
    () =>
      new RemoteResponse(html, { headers: { "Content-Type": "text/html" } }),
  );
}
function image(
  url = "https://example.com/icon.png",
  bytes = png,
  mime = "image/png",
) {
  routes.set(
    url,
    () =>
      new RemoteResponse(new Uint8Array(bytes), {
        headers: { "Content-Type": mime },
      }),
  );
}

it("loads declared site icons without forwarding profile cookies or page query data", async () => {
  page('<link rel="shortcut ICON" href="/icon.png">');
  image();
  const response = await get();
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("image/png");
  expect(Buffer.from(await response.arrayBuffer())).toEqual(png);
  expect(requests.map((request) => request.url)).toEqual([
    "https://example.com/",
    "https://example.com/icon.png",
  ]);
  expect(
    requests.every((request) =>
      Object.keys(request.headers).every(
        (name) => !/^(cookie|authorization|referer)$/i.test(name),
      ),
    ),
  ).toBe(true);
});

it("resolves declared icons against the final page URL and HTML base", async () => {
  routes.set(
    "https://example.com/",
    () =>
      new RemoteResponse(null, {
        status: 302,
        headers: { Location: "https://docs.example.org/guide/" },
      }),
  );
  routes.set(
    "https://docs.example.org/guide/",
    () =>
      new RemoteResponse(
        '<base href="/assets/"><link rel="icon" href="small.png">',
      ),
  );
  image("https://docs.example.org/assets/small.png");
  expect((await get()).status).toBe(200);
  expect(requests.map((request) => request.url)).toContain(
    "https://docs.example.org/assets/small.png",
  );
});

it("uses the standard icon path when the page declares no icon", async () => {
  page("<title>Reference</title>");
  image("https://example.com/favicon.ico");
  expect((await get()).status).toBe(200);
  expect(requests.map((request) => request.url)).toContain(
    "https://example.com/favicon.ico",
  );
});

it("serves valid ICO directories and isolates SVG icons", async () => {
  const header = Buffer.alloc(22);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  header[6] = header[7] = 1;
  header.writeUInt32LE(png.length, 14);
  header.writeUInt32LE(22, 18);
  page('<link rel="icon" href="/icon.png">');
  image(undefined, Buffer.concat([header, png]), "image/x-icon");
  expect((await get()).headers.get("content-type")).toBe("image/x-icon");
  image(
    undefined,
    Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>',
    ),
    "image/svg+xml",
  );
  const response = await get();
  expect(response.headers.get("content-type")).toBe("image/svg+xml");
  expect(response.headers.get("content-security-policy")).toContain("sandbox");
  expect(response.headers.get("content-security-policy")).toContain(
    "default-src 'none'",
  );
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("cache-control")).toContain("private");
});

it("rejects anonymous requests and non-origin inputs before contacting a site", async () => {
  boundary.token = "";
  expect((await get()).status).toBe(401);
  boundary.token = await testSession("alice");
  for (const origin of [
    "https://example.com/private?secret=value",
    "https://user:secret@example.com",
    "http://example.com",
    "file:///private",
  ]) {
    const response = await get(origin);
    expect(response.status).toBe(400);
    expect(response.headers.get("content-security-policy")).toContain(
      "sandbox",
    );
  }
  expect(requests).toEqual([]);
});

it("blocks private destinations in page metadata and redirects through the canonical URL guard", async () => {
  page('<link rel="icon" href="https://127.0.0.1/private">');
  expect((await get()).status).toBe(422);
  expect(requests.map((request) => request.url)).toEqual([
    "https://example.com/",
  ]);
  page('<link rel="icon" href="/icon.png">');
  routes.set(
    "https://example.com/icon.png",
    () =>
      new RemoteResponse(null, {
        status: 302,
        headers: { Location: "http://169.254.169.254/" },
      }),
  );
  expect((await get()).status).toBe(422);
  expect(requests.some((request) => request.url.includes("169.254"))).toBe(
    false,
  );
});

it("surfaces failed or oversized sites and rejects non-image icon responses", async () => {
  routes.set(
    "https://example.com/",
    () => new RemoteResponse("Denied", { status: 403 }),
  );
  expect((await get()).status).toBe(422);
  page("x".repeat(512 * 1024 + 1));
  expect((await get()).status).toBe(422);
  page('<link rel="icon" href="/icon.png">');
  image(undefined, Buffer.alloc(2 * 1024 * 1024 + 1));
  expect((await get()).status).toBe(422);
  image(undefined, Buffer.from("<script>unsafe</script>"), "image/png");
  expect((await get()).status).toBe(422);
});

it("bounds concurrent site lookups and releases slots after completion", async () => {
  const { promise: pending, resolve: release } = Promise.withResolvers<void>();
  page('<link rel="icon" href="/icon.png">');
  image();
  const first = routes.get("https://example.com/")!;
  routes.set("https://example.com/", async () => {
    await pending;
    return first();
  });
  const lookups = [
    loadSiteIcon("https://example.com"),
    loadSiteIcon("https://example.com"),
    loadSiteIcon("https://example.com"),
  ];
  try {
    await expect(loadSiteIcon("https://example.com")).rejects.toBeInstanceOf(
      SiteIconBusyError,
    );
  } finally {
    release();
    await Promise.all(lookups);
  }
  expect((await get()).status).toBe(200);
});
