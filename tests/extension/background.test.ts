import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

type Tab = { id?: number; url?: string };
type ClickHandler = (tab: Tab) => void;

function loadBackground(baseUrl: string) {
  let clickHandler: ClickHandler | undefined;
  const api = {
    action: {
      onClicked: {
        addListener(handler: ClickHandler) {
          clickHandler = handler;
        },
      },
      setBadgeText: vi.fn().mockResolvedValue(undefined),
      setTitle: vi.fn().mockResolvedValue(undefined),
    },
    declarativeNetRequest: {
      getDynamicRules: vi.fn().mockResolvedValue([]),
      updateDynamicRules: vi.fn().mockResolvedValue(undefined),
    },
    permissions: {},
    runtime: {
      onInstalled: { addListener: vi.fn() },
      onMessage: { addListener: vi.fn() },
      openOptionsPage: vi.fn().mockResolvedValue(undefined),
    },
    storage: {
      onChanged: { addListener: vi.fn() },
      sync: { get: vi.fn().mockResolvedValue({ baseUrl }) },
    },
    tabs: { update: vi.fn().mockResolvedValue(undefined) },
  };
  const source = fs.readFileSync(
    path.resolve(import.meta.dirname, "../../extension/background.js"),
    "utf8",
  );
  vm.runInNewContext(source, { chrome: api, console, URL });
  if (!clickHandler)
    throw new Error("background did not register action click");
  return { api, clickHandler };
}

async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
}

describe("browser extension toolbar", () => {
  it("opens extension settings when no Papernook server is configured", async () => {
    const { api, clickHandler } = loadBackground("");

    clickHandler({ id: 3, url: "https://arxiv.org/abs/2401.00001" });
    await settle();

    expect(api.runtime.openOptionsPage).toHaveBeenCalledOnce();
    expect(api.tabs.update).not.toHaveBeenCalled();
  });

  it("opens the current HTTP page in the configured reader in the same tab", async () => {
    const { api, clickHandler } = loadBackground("https://papers.example.com/");

    clickHandler({ id: 7, url: "https://example.org/paper?id=a&view=pdf" });
    await settle();

    expect(api.action.setBadgeText).toHaveBeenCalledWith({
      text: "",
      tabId: 7,
    });
    expect(api.tabs.update).toHaveBeenCalledWith(7, {
      url: "https://papers.example.com/viewer?src=https%3A%2F%2Fexample.org%2Fpaper%3Fid%3Da%26view%3Dpdf",
    });
  });

  it("returns from an original PDF without retaining the bypass marker", async () => {
    const { api, clickHandler } = loadBackground("https://papers.example.com");
    clickHandler({
      id: 7,
      url: "https://example.org/paper.pdf?papernook_original=1#page=3",
    });
    await settle();
    expect(api.tabs.update).toHaveBeenCalledWith(7, {
      url: "https://papers.example.com/viewer?src=https%3A%2F%2Fexample.org%2Fpaper.pdf%23page%3D3",
    });
  });

  it("preserves an original PDF's signed query when returning to the reader", async () => {
    const { api, clickHandler } = loadBackground("https://papers.example.com");
    clickHandler({
      id: 7,
      url: "https://example.org/paper.pdf?signature=a%2Bb#page=2",
    });
    await settle();
    expect(api.tabs.update).toHaveBeenCalledWith(7, {
      url: "https://papers.example.com/viewer?src=https%3A%2F%2Fexample.org%2Fpaper.pdf%3Fsignature%3Da%252Bb%23page%3D2",
    });
  });

  it("surfaces pages whose address Chrome cannot share", async () => {
    const { api, clickHandler } = loadBackground("https://papers.example.com");

    clickHandler({ id: 9, url: "chrome://extensions" });
    await settle();

    expect(api.action.setBadgeText).toHaveBeenCalledWith({
      text: "!",
      tabId: 9,
    });
    expect(api.action.setTitle).toHaveBeenCalledWith(
      expect.objectContaining({ tabId: 9 }),
    );
    expect(api.tabs.update).not.toHaveBeenCalled();
  });
});
