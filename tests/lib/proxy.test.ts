import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "@/proxy";

describe("request proxy", () => {
  it("allows the token-authenticated capture route without a session", () => {
    const response = proxy(new NextRequest("http://papernook.test/add"));
    expect(response.headers.get("x-middleware-next")).toBe("1");
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
});
