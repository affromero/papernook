import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CaptureState } from "@/components/library/useCapture";

type Handler = (url: string, init?: RequestInit) => Response;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

let handler: Handler;

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetModules();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) =>
      handler(String(input), init),
    ),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function loadHook() {
  return import("@/components/library/useCapture");
}

/** Let the interval fire once and its fetch/json promises settle. */
async function tick(): Promise<void> {
  await vi.advanceTimersByTimeAsync(2000);
}

describe("useCapture registry", () => {
  it("moves through adding → added with the final slug and notifies subscribers", async () => {
    let polls = 0;
    handler = (url, init) => {
      if (init?.method === "POST") {
        expect(JSON.parse(String(init.body))).toEqual({
          url: "https://arxiv.org/abs/2308.04079",
        });
        return jsonResponse({ slug: "pending-slug" }, 202);
      }
      expect(url).toContain("slug=pending-slug");
      polls += 1;
      return polls < 2
        ? jsonResponse({ state: "analyzing" })
        : jsonResponse({ state: "done", finalSlug: "gaussian-splatting" });
    };
    const hook = await loadHook();
    const seen: CaptureState[] = [];
    hook.subscribeCapture("https://arxiv.org/abs/2308.04079", () => {
      seen.push(hook.captureState("https://arxiv.org/abs/2308.04079"));
    });

    await hook.startCapture("https://arxiv.org/abs/2308.04079");
    expect(hook.captureState("https://arxiv.org/abs/2308.04079")).toEqual({
      status: "adding",
    });
    await tick();
    expect(hook.captureState("https://arxiv.org/abs/2308.04079").status).toBe(
      "adding",
    );
    await tick();
    const final = hook.captureState("https://arxiv.org/abs/2308.04079");
    expect(final).toEqual({ status: "added", finalSlug: "gaussian-splatting" });
    expect(seen.map((s) => s.status)).toEqual(["adding", "added"]);
    expect(hook.captureInboxHref("gaussian-splatting")).toBe(
      "/inbox/gaussian-splatting",
    );

    // Settled captures stop polling and never restart.
    const before = polls;
    await hook.startCapture("https://arxiv.org/abs/2308.04079");
    await tick();
    expect(polls).toBe(before);
  });

  it("starts one job per URL even when several buttons ask at once", async () => {
    let posts = 0;
    handler = (_url, init) => {
      if (init?.method === "POST") {
        posts += 1;
        return jsonResponse({ slug: "s" }, 202);
      }
      return jsonResponse({ state: "analyzing" });
    };
    const hook = await loadHook();
    await Promise.all([
      hook.startCapture("https://doi.org/10.1/abc"),
      hook.startCapture("https://doi.org/10.1/abc"),
    ]);
    expect(posts).toBe(1);
  });

  it("treats a retired job marker as already added, pointing at the inbox", async () => {
    handler = (_url, init) =>
      init?.method === "POST"
        ? jsonResponse({ slug: "s" }, 202)
        : jsonResponse({ error: "no longer pending" }, 404);
    const hook = await loadHook();
    await hook.startCapture("https://doi.org/10.1/retired");
    await tick();
    expect(hook.captureState("https://doi.org/10.1/retired")).toEqual({
      status: "added",
      finalSlug: null,
    });
    expect(hook.captureInboxHref(null)).toBe("/?topic=_inbox");
  });

  it("surfaces server rejections and job failures with their reason", async () => {
    handler = (_url, init) =>
      init?.method === "POST"
        ? jsonResponse({ error: "Too many captures. Try again later." }, 429)
        : jsonResponse({ state: "analyzing" });
    const hook = await loadHook();
    await hook.startCapture("https://doi.org/10.1/limited");
    expect(hook.captureState("https://doi.org/10.1/limited")).toEqual({
      status: "failed",
      error: "Too many captures. Try again later.",
    });

    handler = (_url, init) =>
      init?.method === "POST"
        ? jsonResponse({ slug: "s" }, 202)
        : jsonResponse({ state: "failed", error: "Already in your library." });
    await hook.startCapture("https://doi.org/10.1/dupe");
    await tick();
    expect(hook.captureState("https://doi.org/10.1/dupe")).toEqual({
      status: "failed",
      error: "Already in your library.",
    });

    // A failed capture may be retried.
    handler = (_url, init) =>
      init?.method === "POST"
        ? jsonResponse({ slug: "s2" }, 202)
        : jsonResponse({ state: "done", finalSlug: "dupe" });
    await hook.startCapture("https://doi.org/10.1/dupe");
    await tick();
    expect(hook.captureState("https://doi.org/10.1/dupe").status).toBe("added");
  });

  it("gives up on a job marker stuck in analyzing and offers a retry", async () => {
    handler = (_url, init) =>
      init?.method === "POST"
        ? jsonResponse({ slug: "s" }, 202)
        : jsonResponse({ state: "analyzing" });
    const hook = await loadHook();
    await hook.startCapture("https://doi.org/10.1/stuck");
    await vi.advanceTimersByTimeAsync(9 * 60 * 1000);
    expect(hook.captureState("https://doi.org/10.1/stuck").status).toBe(
      "adding",
    );
    await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
    const state = hook.captureState("https://doi.org/10.1/stuck");
    expect(state.status).toBe("failed");
    expect(state.status === "failed" && state.error).toMatch(/Inbox/);
    const fetchMock = vi.mocked(fetch);
    const callsAtFailure = fetchMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60 * 1000);
    expect(fetchMock.mock.calls.length).toBe(callsAtFailure);
  });

  it("keeps polling through a network blip", async () => {
    let polls = 0;
    handler = (_url, init) => {
      if (init?.method === "POST") return jsonResponse({ slug: "s" }, 202);
      polls += 1;
      if (polls === 1) throw new TypeError("offline");
      return jsonResponse({ state: "done", finalSlug: "landed" });
    };
    const hook = await loadHook();
    await hook.startCapture("https://doi.org/10.1/blip");
    await tick();
    expect(hook.captureState("https://doi.org/10.1/blip").status).toBe(
      "adding",
    );
    await tick();
    expect(hook.captureState("https://doi.org/10.1/blip")).toEqual({
      status: "added",
      finalSlug: "landed",
    });
  });
});
