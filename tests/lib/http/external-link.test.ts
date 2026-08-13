import { describe, expect, it } from "vitest";
import { externalLinkProps } from "@/lib/external-link";

const origin = "https://papernook.example";

describe("external link attributes", () => {
  it.each([
    [
      "https://other.example/path",
      { target: "_blank", rel: "noopener noreferrer" },
    ],
    [
      "http://other.example/path",
      { target: "_blank", rel: "noopener noreferrer" },
    ],
    ["//other.example/path", { target: "_blank", rel: "noopener noreferrer" }],
    ["https://PAPERNOOK.example:443/paper/x", {}],
    ["//papernook.example/paper/x", {}],
    ["/paper/x", {}],
    ["paper/x", {}],
    ["?topic=math", {}],
    ["#section", {}],
    ["mailto:reader@example.com", {}],
    ["tel:+15555550100", {}],
    ["javascript:void(0)", {}],
    ["not a url", {}],
  ])("classifies %s", (href, expected) => {
    expect(externalLinkProps(href, origin)).toEqual(expected);
  });

  it("adds nofollow when rendering untrusted content", () => {
    expect(externalLinkProps("https://other.example", origin, true)).toEqual({
      target: "_blank",
      rel: "noopener noreferrer nofollow",
    });
  });

  it("treats absolute web URLs as external when no origin is available", () => {
    expect(externalLinkProps("https://papernook.example/paper/x")).toEqual({
      target: "_blank",
      rel: "noopener noreferrer",
    });
    expect(externalLinkProps("/paper/x")).toEqual({});
  });
});
