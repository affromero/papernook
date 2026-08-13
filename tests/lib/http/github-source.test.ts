import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchVerifiedGitHubSource,
  githubBlobUrlFromMessage,
  GitHubSourceError,
  parseGitHubBlobUrl,
} from "@/lib/github-source";

const sha = "2a810a6c353215685307da3d4cc6ebd73b1c387b";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("verified GitHub source", () => {
  it.runIf(process.env.PAPERNOOK_LIVE_GITHUB === "1")(
    "fetches the complete current MeshSplatting training file",
    async () => {
      const source = await fetchVerifiedGitHubSource(
        "https://github.com/meshsplatting/mesh-splatting/blob/main/train.py",
      );

      expect(source.sha).toMatch(/^[a-f0-9]{40}$/);
      expect(source.lines.length).toBeGreaterThan(500);
      expect(source.lines).toContain("    need_delaunay = False");
      expect(source.lines).toContain(
        "                triangles.run_restricted_delaunay()",
      );
      expect(source.lines.at(-1)).toBe('    print("\\nTraining complete.")');
    },
  );

  it("parses one blob URL and ignores its line fragment", () => {
    expect(
      parseGitHubBlobUrl(
        "https://github.com/meshsplatting/mesh-splatting/blob/main/src/train.py?plain=1#L10-L20",
      ),
    ).toEqual({
      owner: "meshsplatting",
      repo: "mesh-splatting",
      ref: "main",
      path: "src/train.py",
    });
    expect(
      githubBlobUrlFromMessage(
        "Read https://github.com/meshsplatting/mesh-splatting/blob/main/train.py#L1-L5.",
      ),
    ).toBe(
      "https://github.com/meshsplatting/mesh-splatting/blob/main/train.py#L1-L5",
    );
  });

  it.each([
    "http://github.com/o/r/blob/main/a.py",
    "https://github.example/o/r/blob/main/a.py",
    "https://user@github.com/o/r/blob/main/a.py",
    "https://github.com:444/o/r/blob/main/a.py",
    "https://github.com/o/r/tree/main/a.py",
    "https://github.com/o/r/blob/main/%2e%2e/a.py",
    "https://github.com/o/r/blob/main/a%2Fb.py",
    "https://github.com/o/r/blob/main/a%5Cb.py",
  ])("rejects unsupported or unsafe URL %s", (url) => {
    expect(() => parseGitHubBlobUrl(url)).toThrow(GitHubSourceError);
  });

  it("rejects a request containing more than one GitHub file", () => {
    expect(() =>
      githubBlobUrlFromMessage(
        "Compare https://github.com/o/r/blob/main/a.py and https://github.com/o/r/blob/main/b.py",
      ),
    ).toThrow("Analyze one GitHub file per message");
  });

  it("resolves a branch then fetches the complete file by immutable SHA", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ sha }), {
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response("first line\n\nlast line\n", {
          headers: { "content-type": "text/plain" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const source = await fetchVerifiedGitHubSource(
      "https://github.com/org/repo/blob/main/src/train.py#L2",
    );

    expect(source).toEqual({
      owner: "org",
      repo: "repo",
      sha,
      path: "src/train.py",
      canonicalUrl: `https://github.com/org/repo/blob/${sha}/src/train.py`,
      lines: ["first line", "", "last line"],
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://api.github.com/repos/org/repo/commits/main",
      expect.objectContaining({ redirect: "manual" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      `https://api.github.com/repos/org/repo/contents/src/train.py?ref=${sha}`,
      expect.objectContaining({
        headers: expect.objectContaining({
          Accept: "application/vnd.github.raw+json",
        }),
        redirect: "manual",
      }),
    );
  });

  it("refetches pinned sources without resolving a moving branch", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("all source lines", {
        headers: { "content-type": "text/plain" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await fetchVerifiedGitHubSource({
      owner: "org",
      repo: "repo",
      sha,
      path: "train.py",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(
      `https://api.github.com/repos/org/repo/contents/train.py?ref=${sha}`,
    );
  });

  it.each([
    [new Response(null, { status: 302 }), "redirected"],
    [new Response("missing", { status: 404 }), "not found"],
    [new Response(new Uint8Array([0, 1, 2])), "binary"],
    [new Response(new Uint8Array([0xc3, 0x28])), "UTF-8"],
    [
      new Response("small", {
        headers: { "content-length": String(300 * 1024) },
      }),
      "too large",
    ],
  ])("rejects an unverifiable source: %s", async (response, message) => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(response));
    await expect(
      fetchVerifiedGitHubSource({
        owner: "org",
        repo: "repo",
        sha,
        path: "train.py",
      }),
    ).rejects.toThrow(message);
  });
});
