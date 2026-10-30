import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { fixture } from "./fixture";

const network = vi.hoisted(() => ({
  lookup: vi.fn(),
  fetch: vi.fn(),
  close: vi.fn(),
  configs: [] as {
    connect: {
      lookup: (
        hostname: string,
        options: { all: boolean },
        callback: (
          error: Error | null,
          addresses: unknown,
          family?: number,
        ) => void,
      ) => void;
    };
  }[],
}));
vi.mock("node:dns/promises", () => ({ lookup: network.lookup }));
vi.mock("undici", () => ({
  Agent: class {
    constructor(options: (typeof network.configs)[number]) {
      network.configs.push(options);
    }
    close = network.close;
  },
  fetch: network.fetch,
}));

let directory: string;
const token = "f".repeat(64);
const shareId = "a".repeat(64);
const link = `https://papers.example/share/nlp/attention/${shareId}`;
beforeEach(() => {
  directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "papernook-sharing-network-"),
  );
  vi.stubEnv("PAPERNOOK_DATA_DIR", directory);
  vi.resetModules();
  network.lookup
    .mockReset()
    .mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
  network.fetch
    .mockReset()
    .mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
  network.close.mockReset().mockResolvedValue(undefined);
  network.configs.length = 0;
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(directory, { recursive: true, force: true });
});

it.each([
  "http://papers.example",
  "https://user:password@papers.example",
  "https://papers.example:8443",
  "https://papers.example:80",
  "https://127.0.0.1",
  "https://2130706433",
  "https://[::1]",
  "https://[::ffff:127.0.0.1]",
])("blocks insecure or private sharing origin %s", async (origin) => {
  const { exchange } = await import("@/lib/sharing/transport");
  await expect(
    exchange(
      `${origin}/share/nlp/attention/${shareId}`,
      { action: "read" },
      token,
    ),
  ).rejects.toBeInstanceOf(Error);
  expect(network.fetch).not.toHaveBeenCalled();
});

it("pins approved DNS and refuses mixed public/private DNS answers", async () => {
  const { exchange } = await import("@/lib/sharing/transport");
  network.lookup.mockResolvedValueOnce([
    { address: "93.184.216.34", family: 4 },
    { address: "10.0.0.8", family: 4 },
  ]);
  await expect(
    exchange(link, { action: "read" }, token),
  ).rejects.toBeInstanceOf(Error);
  expect(network.fetch).not.toHaveBeenCalled();
  expect(await exchange(link, { action: "status" }, token)).toEqual({
    ok: true,
  });
  const callback = vi.fn();
  network.configs[0].connect.lookup("papers.example", { all: true }, callback);
  expect(callback).toHaveBeenCalledWith(null, [
    { address: "93.184.216.34", family: 4 },
  ]);
  const request = network.fetch.mock.calls[0][1];
  expect(request.method).toBe("POST");
  expect(request.headers.Authorization).toBe(`Bearer ${token}`);
  expect(request.redirect).toBe("manual");
});

it("never follows redirects or sends credentials to a redirected origin", async () => {
  const { exchange } = await import("@/lib/sharing/transport");
  network.fetch.mockResolvedValueOnce(
    new Response(null, {
      status: 307,
      headers: { location: "https://attacker.example/steal" },
    }),
  );
  await expect(exchange(link, { action: "read" }, token)).rejects.toMatchObject(
    { status: 502 },
  );
  expect(network.fetch.mock.calls.map((args) => args[0])).toEqual([
    `https://papers.example/api/v1/shares/nlp/attention/${shareId}/exchange`,
  ]);
});

it("redacts remote error text even when it echoes server credentials", async () => {
  const { exchange } = await import("@/lib/sharing/transport");
  network.fetch.mockResolvedValueOnce(
    Response.json({ error: `Bearer ${token} from ${link}` }, { status: 403 }),
  );
  const result = await exchange(link, { action: "read" }, token).catch(
    (error: unknown) => error,
  );
  expect(result).toBeInstanceOf(Error);
  const message = result instanceof Error ? result.message : "";
  expect(message).not.toContain(token);
  expect(message).not.toContain(shareId);
  expect(message).toContain("denied");
});

it("allows only exact administrator-configured private HTTPS origins", async () => {
  vi.stubEnv(
    "PAPERNOOK_SHARING_TRUSTED_ORIGINS",
    "https://private.example:8443",
  );
  network.lookup.mockResolvedValue([{ address: "10.0.0.4", family: 4 }]);
  const { exchange } = await import("@/lib/sharing/transport");
  expect(
    await exchange(
      `https://private.example:8443/share/nlp/attention/${shareId}`,
      { action: "status" },
      token,
    ),
  ).toEqual({ ok: true });
  await expect(
    exchange(
      `https://other.example:8443/share/nlp/attention/${shareId}`,
      { action: "status" },
      token,
    ),
  ).rejects.toBeInstanceOf(Error);
  expect(network.fetch).toHaveBeenCalledTimes(1);
});

it("cancels body reads at their deadline", async () => {
  const { readBoundedJson } = await import("@/lib/bounded-request");
  const cancel = vi.fn();
  const stream = new ReadableStream<Uint8Array>({ start() {}, cancel });
  const request = new Request("https://papers.example", {
    method: "POST",
    body: stream,
    duplex: "half",
  } as RequestInit);
  const controller = new AbortController();
  const result = readBoundedJson(request, 1024, controller.signal);
  controller.abort();
  await expect(result).rejects.toThrow(/timed out/);
  expect(cancel).toHaveBeenCalled();
});

it("does not send a publication when authorization expires during DNS resolution", async () => {
  const { exchange } = await import("@/lib/sharing/transport");
  let completeLookup:
    ((value: { address: string; family: number }[]) => void) | undefined;
  network.lookup.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        completeLookup = resolve;
      }),
  );
  const pending = exchange(
    link,
    { action: "publish", content: "PRIVATE_PUBLICATION" },
    token,
    () => {
      throw new Error("Profile revoked");
    },
  );
  await vi.waitFor(() => expect(completeLookup).toBeDefined());
  completeLookup!([{ address: "93.184.216.34", family: 4 }]);
  await expect(pending).rejects.toMatchObject({ status: 502 });
  expect(network.fetch).not.toHaveBeenCalled();
});

it("refreshes unchanged collaborations without downloading PDFs or resending published conversations", async () => {
  const f = await fixture();
  const { pdfEtag } = await import("@/lib/library/pdf/file");
  const chats = await import("@/lib/library/chats");
  const { publicationRevision } = await import("@/lib/sharing/threads");
  const { packageConversation } = await import("@/lib/sharing/bundle");
  const original = fs.readFileSync(f.pdf);
  const { artifactVersions } = await import("@/lib/sharing/artifacts/snapshot");
  const artifacts = await artifactVersions("nlp", "attention");
  const connection = {
    version: 1 as const,
    url: link,
    token: f.token,
    participantId: f.participant.id,
    username: "ana",
    generation: f.capability.generation,
    mirrorEtag: pdfEtag(fs.readFileSync(f.pdf)),
    artifacts: { source: artifacts, mirror: artifacts },
  };
  f.storage.saveConnection("nlp", "attention", f.capability, connection, true);
  const chat = chats.createChat(
    "nlp",
    "attention",
    "ana",
    "A shared discussion",
  );
  f.storage.rememberPublication("nlp", "attention", chat.id);
  let revision: string | null = null;
  const transmitted: string[] = [];
  network.fetch.mockImplementation(async (url, options) => {
    expect(new URL(url).origin).toBe("https://papers.example");
    const body = JSON.parse(options.body);
    transmitted.push(body.action);
    if (body.action === "changes")
      return Response.json({
        etag: connection.mirrorEtag,
        artifacts,
        threads: revision
          ? [{ id: chat.id, actorId: f.participant.id, revision }]
          : [],
      });
    if (body.action === "publish") {
      revision = publicationRevision(body, f.participant.id);
      return Response.json({ published: true });
    }
    if (body.action === "artifact-versions") return Response.json(artifacts);
    throw new Error(
      "Unexpected transfer of unchanged PDF or conversation data",
    );
  });
  const { syncConnectedPaper } = await import("@/lib/sharing/worker");
  await syncConnectedPaper("nlp", "attention");
  await syncConnectedPaper("nlp", "attention");
  const { syncConnectedArtifacts } =
    await import("@/lib/sharing/artifacts/gateway");
  await f.storage.withConnection("nlp", "attention", f.capability, (current) =>
    syncConnectedArtifacts("nlp", "attention", f.capability, current),
  );
  expect(transmitted).toEqual([
    "changes",
    "publish",
    "changes",
    "artifact-versions",
  ]);
  const expected = publicationRevision(
    packageConversation(
      chats.readChat("nlp", "attention", "ana", chat.id)!,
      f.papers.companionDir("nlp", "attention"),
    ),
    f.participant.id,
  );
  expect(revision).toBe(expected);
  expect(fs.readFileSync(f.pdf)).toEqual(original);
});
