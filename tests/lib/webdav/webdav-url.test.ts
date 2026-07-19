import { describe, expect, it } from "vitest";
import { resolveWebdavUrl } from "@/lib/webdav-url";

describe("WebDAV setup URL", () => {
  it("uses the public dav subdomain for a custom HTTPS domain", () => {
    expect(resolveWebdavUrl("https://papernook.example.com")).toBe(
      "https://dav.papernook.example.com",
    );
  });

  it("uses port 8080 on the same host for local HTTP access", () => {
    expect(resolveWebdavUrl("http://localhost:3000")).toBe(
      "http://localhost:8080",
    );
  });

  it("uses the Tailscale Serve hostname with the raw WebDAV port", () => {
    expect(
      resolveWebdavUrl("https://papernook-server.example-tailnet.ts.net"),
    ).toBe("http://papernook-server.example-tailnet.ts.net:8080");
  });

  it("honors an explicit endpoint for nonstandard proxy layouts", () => {
    expect(
      resolveWebdavUrl(
        "https://papers.example.com",
        "https://storage.example.com/papers/",
      ),
    ).toBe("https://storage.example.com/papers");
  });

  it("rejects an explicit endpoint with a non-WebDAV protocol", () => {
    expect(() =>
      resolveWebdavUrl("https://papers.example.com", "file:///private/papers"),
    ).toThrow(/http or https/);
  });
});
