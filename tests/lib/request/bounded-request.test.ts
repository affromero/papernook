import { describe, expect, it } from "vitest";
import {
  readBoundedJson,
  readBoundedText,
  RequestBodyError,
} from "@/lib/bounded-request";

describe("bounded request bodies", () => {
  it("parses JSON within the byte limit", async () => {
    const request = new Request("http://papernook.test/api", {
      method: "POST",
      body: JSON.stringify({ title: "Paper" }),
    });
    await expect(readBoundedJson(request, 64)).resolves.toEqual({
      title: "Paper",
    });
  });

  it("rejects a declared oversized body before reading it", async () => {
    const request = new Request("http://papernook.test/api", {
      method: "POST",
      headers: { "Content-Length": "100" },
      body: "{}",
    });
    await expect(readBoundedText(request, 10)).rejects.toMatchObject({
      status: 413,
    } satisfies Partial<RequestBodyError>);
  });

  it("stops a chunked body once streamed bytes exceed the limit", async () => {
    const request = new Request("http://papernook.test/api", {
      method: "POST",
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("12345"));
          controller.enqueue(new TextEncoder().encode("67890"));
          controller.close();
        },
      }),
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    await expect(readBoundedText(request, 8)).rejects.toMatchObject({
      status: 413,
    } satisfies Partial<RequestBodyError>);
  });
});
