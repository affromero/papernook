import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { proxy, publicRequestLimit } from "@/proxy";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("request proxy", () => {
  it("keeps the production request limit unless a positive integer overrides it", () => {
    expect(publicRequestLimit()).toBe(120);

    vi.stubEnv("PAPERNOOK_PUBLIC_REQUEST_LIMIT", "1000");
    expect(publicRequestLimit()).toBe(1000);

    vi.stubEnv("PAPERNOOK_PUBLIC_REQUEST_LIMIT", "unlimited");
    expect(publicRequestLimit()).toBe(120);
  });

  it("allows the token-authenticated capture route without a session", () => {
    const response = proxy(new NextRequest("http://papernook.test/add"));
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });

  it("uses a per-request nonce instead of allowing inline scripts", () => {
    const first = proxy(new NextRequest("http://papernook.test/login"));
    const second = proxy(new NextRequest("http://papernook.test/login"));
    const firstCsp = first.headers.get("content-security-policy");
    const secondCsp = second.headers.get("content-security-policy");
    expect(firstCsp).toMatch(
      /script-src 'self' 'nonce-[^']+' 'strict-dynamic'/,
    );
    expect(firstCsp).not.toContain("script-src 'self' 'unsafe-inline'");
    expect(secondCsp).not.toBe(firstCsp);
  });

  it("returns a JSON 401 for unauthenticated API requests", async () => {
    const response = proxy(
      new NextRequest("http://papernook.test/api/v1/papers/nlp/attention"),
    );
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Not signed in." });
  });

  it("redirects unauthenticated pages to the picker without preserving query data", () => {
    const response = proxy(
      new NextRequest("http://papernook.test/settings?token=should-not-leak"),
    );
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      "http://papernook.test/login",
    );
  });

  it("gates every hostname identically, with no host-selected weak mode", () => {
    // Host headers are attacker-controlled, so no hostname may unlock a
    // softer path: a raw-port request is gated exactly like the public name.
    const rawPort = proxy(
      new NextRequest("http://127.0.0.1:3000/settings", {
        headers: { host: "localhost" },
      }),
    );
    const publicName = proxy(
      new NextRequest("https://papers.example.com/settings"),
    );
    expect(rawPort.status).toBe(307);
    expect(publicName.status).toBe(307);
  });

  it("lets a share link through on its id alone", () => {
    // The unguessable share id is the credential; a recipient has no account.
    const share = proxy(
      new NextRequest("https://papers.example.com/share/nlp/paper/token"),
    );
    expect(share.status).toBe(200);
  });
});
