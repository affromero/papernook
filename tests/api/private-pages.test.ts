import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createTestProfile,
  deleteTestProfile,
  mockTestSession,
  testProfileCapability,
  testAccess,
} from "../helpers/access";

let directory: string;
beforeEach(async () => {
  directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "papernook-private-pages-"),
  );
  vi.stubEnv("PAPERNOOK_DATA_DIR", directory);
  await createTestProfile("Reader");
  await mockTestSession("reader");
});

it("renders current private capture credentials using the configured public origin", async () => {
  const token = await mockTestSession("reader");
  const { identity } = await testAccess();
  const previous = (await identity.read()).profiles.find(
    (profile) => profile.username === "reader",
  )!;
  const { ProfileOperations } = await import("@/lib/auth/profile-operations");
  const current = await new ProfileOperations(identity).updatePreferences(
    token!,
    "reader",
    { rotateCaptureToken: true },
  );
  vi.stubEnv("PAPERNOOK_URL", "https://papers.example");
  vi.doMock("next/navigation", async () => ({
    ...(await vi.importActual<typeof import("next/navigation")>(
      "next/navigation",
    )),
    useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  }));
  const { default: SettingsPage } = await import("@/app/settings/page");
  const html = renderToStaticMarkup(await SettingsPage());
  expect(html).toContain(current.captureToken);
  expect(html).not.toContain(previous.captureToken);
  expect(html).toContain("papers.example");
});
afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  vi.doUnmock("next/navigation");
  vi.doUnmock("next/headers");
  vi.unstubAllEnvs();
  fs.rmSync(directory, { recursive: true, force: true });
});

it("hides the household profile list when admission is revoked before its latest snapshot", async () => {
  const token = await mockTestSession("reader");
  const { identity, access } = await testAccess();
  const admitted = fs.readFileSync(identity.file, "utf8");
  await access.logout(token!);
  const readFile = fsPromises.readFile;
  // Serve the already-admitted filesystem snapshot for initialization and
  // authentication, then expose the revocation on the page's latest read.
  const admittedReads = [admitted, admitted];
  vi.spyOn(fsPromises, "readFile").mockImplementation((...args) => {
    if (String(args[0]) === identity.file && admittedReads.length)
      return Promise.resolve(admittedReads.shift()!);
    return readFile(...args);
  });
  syncBuiltinESMExports();
  const { default: LoginPage } = await import("@/app/login/page");
  const { AccessGate } = await import("@/components/profiles/AccessGate");
  const page = await LoginPage({ searchParams: Promise.resolve({}) });
  expect(page.type).toBe(AccessGate);
  expect(page.props).not.toHaveProperty("profiles");
});

it.each(["inbox", "viewer"])(
  "rejects delayed %s page reads after profile replacement",
  async (page) => {
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let resume!: (value: { slug: string; src: string }) => void;
    const pending = new Promise<{ slug: string; src: string }>((resolve) => {
      resume = resolve;
    });
    const params = new Proxy(pending, {
      get(target, key) {
        if (key === "then") {
          entered();
          return target.then.bind(target);
        }
        return Reflect.get(target, key);
      },
    });
    const result =
      page === "inbox"
        ? (await import("@/app/inbox/[slug]/page")).default({ params })
        : (await import("@/app/viewer/page")).default({ searchParams: params });
    const rejected = expect(result).rejects.toThrow("NEXT_REDIRECT");
    await started;
    await deleteTestProfile("reader");
    await createTestProfile("Reader");
    resume({ slug: "paper", src: "https://example.com/paper.pdf" });
    await rejected;
  },
);

it("rejects deferred library rendering after the profile is replaced", async () => {
  const capability = testProfileCapability("reader");
  await deleteTestProfile("reader");
  await createTestProfile("Reader");
  const { LibraryView } = await import("@/components/library/LibraryView");
  expect(() =>
    LibraryView({
      query: "",
      activeTag: null,
      activeTopic: null,
      captureToken: "old-token",
      capability,
    }),
  ).toThrow("NEXT_REDIRECT");
});

it("does not read private conversation metadata after delayed params and profile replacement", async () => {
  const { generateMetadata } = await import("@/app/conversations/[id]/page");
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let resume!: (value: { id: string }) => void;
  const pending = new Promise<{ id: string }>((resolve) => {
    resume = resolve;
  });
  const params = new Proxy(pending, {
    get(target, key) {
      if (key === "then") {
        entered();
        return target.then.bind(target);
      }
      return Reflect.get(target, key);
    },
  });
  const metadata = generateMetadata({ params });
  const rejected = expect(metadata).rejects.toThrow("NEXT_REDIRECT");
  await started;
  await deleteTestProfile("reader");
  await createTestProfile("Reader");
  resume({ id: "private-conversation" });
  await rejected;
});
