import { downloadOffline, formatBytes, probeConnection } from "./download";
import {
  clearOfflineForAuthentication,
  getOfflineIdentity,
  listOffline,
  offlineError,
  readOffline,
  removeOffline,
  subscribeOffline,
} from "./storage";
import type { DocumentKind, OfflineRecord } from "./types";
import {
  parseReadingPosition,
  readingPositionKey,
  serializeReadingPosition,
} from "../pdf/view/reading-position";

const root = document.getElementById("app")!;
const params = new URLSearchParams(location.search);
const returnPath = params.get("return");
let kind: DocumentKind = "paper";
let selected: OfflineRecord | null = null;
let activeOwner: string | null = null;
let renderGeneration = 0;
let loadGeneration = 0;
let releaseReader: (() => void) | undefined;
let records: OfflineRecord[] = [];
let query = "";
let topic = "";
let lastState = "offline";
let bootReady = false;

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text?: string,
  className?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function button(
  label: string,
  action: () => void | Promise<void>,
): HTMLButtonElement {
  const node = element("button", label);
  node.type = "button";
  node.addEventListener("click", () => {
    node.disabled = true;
    Promise.resolve(action())
      .catch(showError)
      .finally(() => {
        node.disabled = false;
      });
  });
  return node;
}

function showError(error: unknown): void {
  const notice = document.getElementById("notice");
  if (notice) {
    notice.textContent = offlineError(error);
    notice.setAttribute("role", "alert");
  }
}

function saveFile(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = element("a");
  anchor.href = url;
  anchor.download = name.replace(/[^\p{L}\p{N}._ -]/gu, "-").slice(0, 160);
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

function frameHtml(html: string, title: string, key: string): HTMLElement {
  const wrapper = element("section", undefined, "reading");
  const actions = element("div", undefined, "actions");
  const frame = element("iframe");
  frame.title = title;
  frame.setAttribute("sandbox", "allow-same-origin allow-modals");
  frame.srcdoc = html;
  actions.append(
    button("Download HTML", () =>
      saveFile(
        new Blob([html], { type: "text/html;charset=utf-8" }),
        `${title}.html`,
      ),
    ),
    button("Print / Save as PDF", () => frame.contentWindow?.print()),
  );
  const storageKey = `papernook:offline-position:${key}`;
  frame.addEventListener("load", () => {
    try {
      frame.contentWindow?.scrollTo(
        0,
        Number(localStorage.getItem(storageKey)) || 0,
      );
      frame.contentWindow?.addEventListener("scroll", () => {
        localStorage.setItem(
          storageKey,
          String(frame.contentWindow?.scrollY ?? 0),
        );
      });
    } catch {
      /* Reading is still available when position storage is disabled. */
    }
  });
  wrapper.append(actions, frame);
  return wrapper;
}

async function pdfReader(
  record: OfflineRecord,
  container: HTMLElement,
  generation: number,
): Promise<void> {
  if (!record.pdf) return;
  // The build vendors this complete dependency set into the shell precache.
  const modulePath = "/offline/pdf/pdf.mjs";
  const pdfjs: typeof import("pdfjs-dist") = await import(
    /* webpackIgnore: true */ modulePath
  );
  if (generation !== renderGeneration) return;
  pdfjs.GlobalWorkerOptions.workerSrc = "/offline/pdf/pdf.worker.mjs";
  const task = pdfjs.getDocument({
    data: new Uint8Array(await record.pdf.arrayBuffer()),
    cMapUrl: "/offline/pdf/cmaps/",
    cMapPacked: true,
    standardFontDataUrl: "/offline/pdf/standard_fonts/",
    wasmUrl: "/offline/pdf/wasm/",
  });
  if (generation !== renderGeneration) {
    await task.destroy();
    return;
  }
  releaseReader = () => {
    void task.destroy();
  };
  const pdf = await task.promise;
  if (generation !== renderGeneration) {
    await task.destroy();
    return;
  }
  const [, paperTopic, slug] = record.manifest.key.split(":");
  const positionKey = readingPositionKey(
    paperTopic,
    slug,
    record.manifest.owner,
  );
  let pageNumber = 1;
  try {
    pageNumber = Math.min(
      pdf.numPages,
      parseReadingPosition(localStorage.getItem(positionKey))?.page ?? 1,
    );
  } catch {
    /* Position is optional. */
  }
  const controls = element("div", undefined, "actions");
  const label = element("span");
  const canvas = element("canvas");
  canvas.setAttribute("aria-label", "Downloaded PDF page");
  const pageInput = element("input");
  pageInput.type = "number";
  pageInput.min = "1";
  pageInput.max = String(pdf.numPages);
  pageInput.setAttribute("aria-label", "PDF page");
  let rendering:
    ReturnType<Awaited<ReturnType<typeof pdf.getPage>>["render"]> | undefined;
  let pageGeneration = 0;
  async function paint(): Promise<void> {
    const current = ++pageGeneration;
    rendering?.cancel();
    const page = await pdf.getPage(pageNumber);
    if (current !== pageGeneration || generation !== renderGeneration) return;
    const original = page.getViewport({ scale: 1 });
    const scale = Math.max(
      0.2,
      Math.min(2, (container.clientWidth - 24) / original.width),
    );
    const viewport = page.getViewport({ scale });
    const ratio = Math.min(devicePixelRatio || 1, 2);
    canvas.width = Math.ceil(viewport.width * ratio);
    canvas.height = Math.ceil(viewport.height * ratio);
    rendering = page.render({
      canvas,
      viewport,
      transform: [ratio, 0, 0, ratio, 0, 0],
    });
    try {
      await rendering.promise;
    } catch (error) {
      if (
        error instanceof Error &&
        error.name !== "RenderingCancelledException"
      )
        throw error;
    }
    label.textContent = `of ${pdf.numPages}`;
    pageInput.value = String(pageNumber);
    try {
      localStorage.setItem(
        positionKey,
        serializeReadingPosition({
          page: pageNumber,
          scale,
          viewport: container.clientWidth,
          updatedAt: Date.now(),
        }),
      );
    } catch {
      /* Position is optional. */
    }
  }
  const move = async (delta: number) => {
    pageNumber = Math.max(1, Math.min(pdf.numPages, pageNumber + delta));
    await paint();
  };
  pageInput.addEventListener("change", () => {
    pageNumber = Math.max(
      1,
      Math.min(pdf.numPages, Math.floor(Number(pageInput.value)) || 1),
    );
    void paint().catch(showError);
  });
  controls.append(
    button("Previous", () => move(-1)),
    pageInput,
    label,
    button("Next", () => move(1)),
    button("Download PDF", () =>
      saveFile(record.pdf!, `${record.manifest.title}.pdf`),
    ),
  );
  container.append(controls, canvas);
  await paint();
  if (generation !== renderGeneration) {
    await task.destroy();
    return;
  }
  const resize = () => {
    void paint().catch(showError);
  };
  window.addEventListener("resize", resize);
  releaseReader = () => {
    window.removeEventListener("resize", resize);
    rendering?.cancel();
    void task.destroy();
  };
}

async function openRecord(record: OfflineRecord): Promise<void> {
  const pendingGeneration = renderGeneration;
  const identity = await getOfflineIdentity();
  const current = await readOffline(record.manifest.key);
  const latest = await getOfflineIdentity();
  if (
    !current ||
    !identity.owner ||
    identity.owner !== latest.owner ||
    identity.generation !== latest.generation ||
    pendingGeneration !== renderGeneration
  )
    return;
  record = current;
  releaseReader?.();
  releaseReader = undefined;
  selected = record;
  const generation = ++renderGeneration;
  const content = document.getElementById("content")!;
  content.replaceChildren();
  const header = element("header", undefined, "document-header");
  header.append(
    button("← Downloads", () => {
      selected = null;
      params.delete("key");
      history.replaceState(null, "", `/offline/index.html?${params}`);
      showLibrary();
    }),
    element("h1", record.manifest.title),
  );
  header.append(
    element(
      "p",
      `${record.manifest.topic} · Saved ${new Date(record.downloadedAt).toLocaleString()}`,
    ),
  );
  const connectionNote = element(
    "p",
    "Saved copy. Connect to continue this conversation or edit annotations.",
    "connection-note",
  );
  header.append(connectionNote);
  const online = element("a", "Open online");
  online.href = record.manifest.onlineUrl;
  header.append(online);
  const tabs = element("div", undefined, "tabs");
  const reader = element("div", undefined, "reader");
  function changeTab(html: string, title: string, suffix: string): void {
    ++renderGeneration;
    releaseReader?.();
    releaseReader = undefined;
    reader.replaceChildren(
      frameHtml(html, title, `${record.manifest.key}:${suffix}`),
    );
  }
  tabs.append(
    button(record.pdf ? "Paper" : "Transcript", async () => {
      await openRecord(record);
    }),
  );
  if (record.manifest.summaryHtml)
    tabs.append(
      button("Summary", () =>
        changeTab(
          record.manifest.summaryHtml,
          `${record.manifest.title} summary`,
          "summary",
        ),
      ),
    );
  if (record.pdf)
    tabs.append(
      button("Paper text", () =>
        changeTab(record.manifest.sourceHtml, record.manifest.title, "source"),
      ),
    );
  for (const chat of record.manifest.chats)
    tabs.append(
      button(chat.title, () =>
        changeTab(chat.html, chat.title, `chat:${chat.id}`),
      ),
    );
  content.append(header, tabs, reader);
  params.set("key", record.manifest.key);
  history.replaceState(null, "", `/offline/index.html?${params}`);
  if (record.pdf) await pdfReader(record, reader, generation);
  else
    reader.append(
      frameHtml(
        record.manifest.sourceHtml,
        record.manifest.title,
        `${record.manifest.key}:source`,
      ),
    );
}

function showLibrary(): void {
  ++renderGeneration;
  releaseReader?.();
  releaseReader = undefined;
  const content = document.getElementById("content")!;
  content.replaceChildren();
  const heading = element("header", undefined, "document-header");
  heading.append(
    element("p", "On this device", "eyebrow"),
    element("h1", "Your offline library"),
    element(
      "p",
      "Read downloaded papers, conversations and saved chats without a connection.",
    ),
  );
  const tabs = element("div", undefined, "tabs");
  for (const type of ["paper", "conversation"] as const) {
    const tab = button(type === "paper" ? "Papers" : "Conversations", () => {
      kind = type;
      topic = "";
      showLibrary();
    });
    tab.setAttribute("aria-pressed", String(kind === type));
    tabs.append(tab);
  }
  const filters = element("div", undefined, "filters");
  const search = element("input");
  search.type = "search";
  search.placeholder = "Search downloads and saved chats";
  search.setAttribute("aria-label", "Search downloads");
  search.value = query;
  const categories = element("select");
  categories.setAttribute("aria-label", "Category");
  const all = element("option", "All categories");
  all.value = "";
  categories.append(all);
  for (const name of [
    ...new Set(
      records
        .filter((r) => r.manifest.kind === kind)
        .map((r) => r.manifest.topic),
    ),
  ].sort()) {
    const option = element("option", name);
    option.value = name;
    categories.append(option);
  }
  categories.value = topic;
  const grid = element("div", undefined, "grid");
  function drawCards(): void {
    grid.replaceChildren();
    const matches = records.filter(
      ({ manifest: m }) =>
        m.kind === kind &&
        (!topic || m.topic === topic) &&
        `${m.title} ${m.topic} ${m.tags.join(" ")} ${m.text} ${m.chats.map((c) => c.title + " " + c.html.replace(/<[^>]*>/g, " ")).join(" ")}`
          .toLowerCase()
          .includes(query.toLowerCase()),
    );
    for (const record of matches) {
      const card = element("article", undefined, "card");
      const open = button(record.manifest.title, () => openRecord(record));
      open.className = "card-title";
      card.append(
        element("p", record.manifest.topic, "eyebrow"),
        open,
        element(
          "p",
          `${formatBytes(record.bytes)} · Saved ${new Date(record.downloadedAt).toLocaleDateString()}`,
        ),
      );
      card.append(element("p", `${record.manifest.chats.length} saved chats`));
      const actions = element("div", undefined, "actions");
      actions.append(
        button("Update download", async () => {
          await downloadOffline(record.manifest.snapshotUrl);
          await loadLibrary();
        }),
        button("Remove download", async () => {
          await removeOffline(record.manifest.key);
          await loadLibrary();
        }),
      );
      card.append(actions);
      grid.append(card);
    }
    if (!matches.length)
      grid.append(
        element(
          "p",
          query || topic
            ? "No downloads match this search."
            : `No ${kind === "paper" ? "papers" : "conversations"} downloaded. While online, open a document and choose Available offline.`,
          "empty",
        ),
      );
  }
  search.addEventListener("input", () => {
    query = search.value;
    drawCards();
  });
  categories.addEventListener("change", () => {
    topic = categories.value;
    drawCards();
  });
  filters.append(search, categories);
  const settings = element("section", undefined, "storage");
  settings.id = "storage";
  settings.append(
    element("h2", "Offline storage"),
    element(
      "p",
      `${records.length} downloads · ${formatBytes(records.reduce((sum, record) => sum + record.bytes, 0))}`,
    ),
    element(
      "p",
      "Downloads are stored in this browser on this device. Removing them leaves your server library intact. Switching profiles or logging out clears private downloads. Use Download PDF or HTML to keep independent files.",
    ),
  );
  settings.append(
    button("Clear all downloads", async () => {
      if (
        confirm(
          "Remove all downloads from this device? Server documents will remain.",
        )
      ) {
        await removeOffline();
        await loadLibrary();
      }
    }),
  );
  content.append(heading, tabs, filters, grid, settings);
  drawCards();
}

async function loadLibrary(): Promise<void> {
  const generation = ++loadGeneration;
  const identity = await getOfflineIdentity();
  const downloaded = await listOffline();
  const latest = await getOfflineIdentity();
  if (
    generation !== loadGeneration ||
    identity.owner !== latest.owner ||
    identity.generation !== latest.generation
  )
    return;
  activeOwner = identity.owner;
  records = downloaded;
  if (!identity.owner) {
    ++renderGeneration;
    releaseReader?.();
    selected = null;
    document
      .getElementById("content")!
      .replaceChildren(
        element("h1", "No offline profile"),
        element(
          "p",
          "Connect and sign in, then download a paper or conversation for offline reading.",
        ),
      );
    return;
  }
  if (selected) {
    const current = await readOffline(selected.manifest.key);
    if (generation !== loadGeneration) return;
    if (current) return;
    selected = null;
  }
  showLibrary();
}

async function checkConnection(): Promise<void> {
  const before = await getOfflineIdentity();
  const connection = await probeConnection();
  const after = await getOfflineIdentity();
  if (before.owner !== after.owner || before.generation !== after.generation)
    return;
  const status = document.getElementById("status")!;
  status.textContent =
    connection.state === "online"
      ? "Connected · saved library"
      : connection.state === "busy"
        ? "Server busy · saved library"
        : "Offline · saved library";
  if (
    connection.state === "signed-out" ||
    (connection.state === "online" &&
      activeOwner &&
      connection.owner !== activeOwner)
  ) {
    clearVisiblePrivateData();
    await clearOfflineForAuthentication();
    location.replace("/login");
    return;
  }
  if (
    connection.state === "online" &&
    (returnPath || selected) &&
    lastState !== "online" &&
    connection.owner === activeOwner
  ) {
    const target = selected?.manifest.onlineUrl ?? returnPath;
    if (
      target &&
      target.startsWith("/") &&
      !target.startsWith("//") &&
      !target.includes("\\") &&
      !target.startsWith("/offline/") &&
      new URL(target, location.origin).origin === location.origin
    )
      location.replace(target);
  }
  lastState = connection.state;
}

function clearVisiblePrivateData(): void {
  ++renderGeneration;
  ++loadGeneration;
  releaseReader?.();
  releaseReader = undefined;
  selected = null;
  records = [];
  document.getElementById("content")?.replaceChildren();
}

async function boot(): Promise<void> {
  const masthead = element("header", undefined, "masthead");
  const home = element("a", "papernook");
  home.href = "/";
  const status = element("span", "Offline · saved library");
  status.id = "status";
  masthead.append(home, status);
  const notice = element("p", undefined, "notice");
  notice.id = "notice";
  notice.setAttribute("aria-live", "polite");
  const content = element("main");
  content.id = "content";
  root.append(masthead, notice, content);
  subscribeOffline(() => {
    const key = selected?.manifest.key;
    const previousOwner = activeOwner;
    clearVisiblePrivateData();
    if (!bootReady) return;
    void (async () => {
      await loadLibrary();
      if (key && activeOwner === previousOwner) {
        const current = await readOffline(key);
        if (current) await openRecord(current);
      }
    })().catch(showError);
  });
  const initialIdentity = await getOfflineIdentity();
  const initialConnection = await probeConnection();
  const latestIdentity = await getOfflineIdentity();
  if (
    initialIdentity.owner === latestIdentity.owner &&
    initialIdentity.generation === latestIdentity.generation &&
    (initialConnection.state === "signed-out" ||
      (initialConnection.state === "online" &&
        initialIdentity.owner &&
        initialConnection.owner !== initialIdentity.owner))
  ) {
    await clearOfflineForAuthentication();
    location.replace("/login");
    return;
  }
  if (!returnPath) lastState = initialConnection.state;
  bootReady = true;
  await loadLibrary();
  const key = params.get("key");
  const requested = key
    ? await readOffline(key)
    : records.find((r) => r.manifest.onlineUrl === returnPath?.split("?")[0]);
  if (requested) await openRecord(requested);
  else if (returnPath && /^\/(paper|conversations)\//.test(returnPath))
    showError(
      new Error(
        "This document was not downloaded. Choose an available document below.",
      ),
    );
  window.addEventListener("online", () => {
    void checkConnection().catch(showError);
  });
  window.addEventListener("offline", () => {
    document.getElementById("status")!.textContent = "Offline · saved library";
    lastState = "offline";
  });
  window.setInterval(() => {
    void checkConnection().catch(showError);
  }, 15_000);
  void checkConnection().catch(showError);
}

void boot().catch((error) => {
  root.replaceChildren(
    element("h1", "Offline library unavailable"),
    element("p", offlineError(error)),
  );
});
