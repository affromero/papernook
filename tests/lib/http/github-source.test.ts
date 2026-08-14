import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  fetchVerifiedGitHubSource,
  githubBlobUrlFromMessage,
  GitHubSourceError,
  parseGitHubBlobUrl,
} from "@/lib/github-source";

const sha = "2a810a6c353215685307da3d4cc6ebd73b1c387b";
let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "papernook-github-source-"));
  process.env.PAPERNOOK_DATA_DIR = tmpDir;
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.GITHUB_TOKEN;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("verified GitHub source", () => {
  it.runIf(process.env.PAPERNOOK_LIVE_GITHUB === "1")(
    "fetches the complete current MeshSplatting training file",
    async () => {
      const source = await fetchVerifiedGitHubSource(
        "https://github.com/meshsplatting/mesh-splatting/blob/main/train.py",
      );

      expect(source.sha).toMatch(/^[a-f0-9]{40}$/);
      const training = source.files.find((file) => file.path === "train.py");
      const paths = source.files.map((file) => file.path);
      expect(source.files.length).toBeGreaterThan(10);
      expect(paths).toEqual(
        expect.arrayContaining([
          "arguments/__init__.py",
          "scene/__init__.py",
          "scene/triangle_model.py",
          "triangle_renderer/__init__.py",
          "utils/loss_utils.py",
        ]),
      );
      expect(training?.lines.length).toBeGreaterThan(500);
      expect(training?.lines).toContain("    need_delaunay = False");
      expect(training?.lines).toContain(
        "                triangles.run_restricted_delaunay()",
      );
      expect(training?.lines.at(-1)).toBe('    print("\\nTraining complete.")');
      expect(source.complete).toBe(false);
      expect(source.omittedPaths).toEqual(
        expect.arrayContaining([
          expect.stringContaining("diff-triangle-mesh-rasterization"),
        ]),
      );
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
    ).toThrow("Analyze one GitHub repository per message");
  });

  it("resolves a branch then fetches a pinned multi-file repository", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ sha }), {
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            truncated: false,
            tree: [
              { path: "src/model.py", type: "blob", size: 12 },
              { path: "src/train.py", type: "blob", size: 22 },
              { path: "assets/teaser.png", type: "blob", size: 1000 },
            ],
          }),
        ),
      )
      .mockResolvedValueOnce(new Response("first line\n\nlast line\n"))
      .mockResolvedValueOnce(new Response("class Model: pass\n"));
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
      files: [
        { path: "src/train.py", lines: ["first line", "", "last line"] },
        { path: "src/model.py", lines: ["class Model: pass"] },
      ],
      complete: true,
      omittedFileCount: 0,
      omittedPaths: [],
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://api.github.com/repos/org/repo/commits/main",
      expect.objectContaining({ redirect: "manual" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      `https://api.github.com/repos/org/repo/git/trees/${sha}?recursive=1`,
      expect.objectContaining({
        headers: expect.objectContaining({
          Accept: "application/vnd.github+json",
        }),
        redirect: "manual",
      }),
    );
  });

  it("refetches pinned sources without resolving a moving branch", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            truncated: false,
            tree: [{ path: "train.py", type: "blob", size: 16 }],
          }),
        ),
      )
      .mockResolvedValueOnce(new Response("all source lines"));
    vi.stubGlobal("fetch", fetchMock);

    const identity = {
      owner: "org",
      repo: "repo",
      sha,
      path: "train.py",
    } as const;
    await fetchVerifiedGitHubSource(identity);
    await fetchVerifiedGitHubSource(identity);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe(
      `https://api.github.com/repos/org/repo/git/trees/${sha}?recursive=1`,
    );
  });

  it("surfaces GitHub API rate limits", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response("rate limited", {
          status: 403,
          headers: { "x-ratelimit-remaining": "0" },
        }),
      ),
    );

    await expect(
      fetchVerifiedGitHubSource({
        owner: "org",
        repo: "repo",
        sha,
        path: "train.py",
      }),
    ).rejects.toMatchObject({ status: 429 });
  });

  it.each([
    [new Response(null, { status: 302 }), "redirected"],
    [new Response("missing", { status: 404 }), "not found"],
    [
      new Response("small", {
        headers: { "content-length": String(5 * 1024 * 1024) },
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

  it.each([
    [new Uint8Array([0, 1, 2]), "UTF-8 source"],
    [new Uint8Array([0xc3, 0x28]), "UTF-8 source"],
  ])("rejects an invalid linked source file", async (contents, message) => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              truncated: false,
              tree: [{ path: "train.py", type: "blob", size: 3 }],
            }),
          ),
        )
        .mockResolvedValueOnce(new Response(contents)),
    );
    await expect(
      fetchVerifiedGitHubSource({
        owner: "org",
        repo: "repo",
        sha,
        path: "train.py",
      }),
    ).rejects.toThrow(message);
  });

  it("rejects truncated trees instead of claiming repository completeness", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response(JSON.stringify({ truncated: true, tree: [] })),
        ),
    );
    await expect(
      fetchVerifiedGitHubSource({
        owner: "org",
        repo: "repo",
        sha,
        path: "train.py",
      }),
    ).rejects.toThrow("truncated");
  });
});
