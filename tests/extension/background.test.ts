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
    tabs: { create: vi.fn().mockResolvedValue(undefined) },
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
    expect(api.tabs.create).not.toHaveBeenCalled();
  });

  it("opens the current HTTP page in the configured reader", async () => {
    const { api, clickHandler } = loadBackground("https://papers.example.com/");

    clickHandler({ id: 7, url: "https://example.org/paper?id=a&view=pdf" });
    await settle();

    expect(api.action.setBadgeText).toHaveBeenCalledWith({
      text: "",
      tabId: 7,
    });
    expect(api.tabs.create).toHaveBeenCalledWith({
      url: "https://papers.example.com/viewer?src=https%3A%2F%2Fexample.org%2Fpaper%3Fid%3Da%26view%3Dpdf",
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
    expect(api.tabs.create).not.toHaveBeenCalled();
  });
});
