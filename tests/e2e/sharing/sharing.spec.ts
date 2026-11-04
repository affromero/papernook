import { expect, test, type Page } from "@playwright/test";
import http from "node:http";
import { restoreMayaSession } from "../support/member-session";
import {
  PDFDocument,
  PDFDict,
  PDFName,
  PDFString,
  PDFHexString,
} from "pdf-lib";
import fs from "node:fs/promises";
import path from "node:path";

const source = "/api/v1/papers/machine-learning/attention-is-all-you-need";
let originalPdf: Buffer;
let shareId: string | null;
let copyPath: string | null;

async function saveAnnotations(page: Page, base: string) {
  await expect(
    page.getByRole("button", { name: "Save annotations in PDF" }),
  ).toBeEnabled();
  const pending = page.waitForResponse(
    (response) =>
      response.request().method() === "PUT" &&
      response.url().endsWith(`${base}/pdf`),
  );
  await page.getByRole("button", { name: "Save annotations in PDF" }).click();
  const response = await pending;
  expect(response.ok(), await response.text()).toBe(true);
  await expect(page.locator(".freeTextAnnotation").first()).toBeVisible({
    timeout: 30_000,
  });
}

function annotationValues(document: PDFDocument) {
  return (document.getPage(0).node.Annots()?.asArray() ?? []).map((ref) => {
    const dict = document.context.lookup(ref, PDFDict);
    const text = (key: string) =>
      dict.lookupMaybe(PDFName.of(key), PDFString, PDFHexString)?.decodeText();
    return {
      type: dict.get(PDFName.of("Subtype"))?.toString(),
      content: text("Contents"),
      name: text("NM"),
      author: text("T"),
      actor: text("PapernookAuthor"),
    };
  });
}

test.beforeEach(async ({ page }) => {
  shareId = null;
  copyPath = null;
  await restoreMayaSession(page);
  originalPdf = await (await page.request.get(`${source}/pdf`)).body();
});
test.afterEach(async ({ page }) => {
  if (shareId) await page.request.delete(`${source}/shares/${shareId}`);
  if (copyPath)
    await page.request.delete(copyPath.replace("/paper/", "/api/v1/papers/"));
  const current = await page.request.get(`${source}/pdf`);
  if (current.ok()) {
    await new Promise((resolve) => setTimeout(resolve, 5200));
    await page.request.put(`${source}/pdf`, {
      headers: {
        "Content-Type": "application/pdf",
        "If-Match": current.headers().etag,
      },
      data: originalPdf,
    });
  }
});

test("shared readings use the paper workspace without allowing edits", async ({
  page,
  browser,
}) => {
  for (const mode of ["view", "fork", "collaborate"] as const) {
    const created = await page.request.post(`${source}/shares`, {
      data: {
        mode,
        chatIds: ["0123456789abcdef"],
        ...(mode === "collaborate"
          ? { acknowledgePublicAnnotations: true }
          : {}),
      },
    });
    expect(created.ok(), await created.text()).toBe(true);
    const { share } = await created.json();
    shareId = share.id;
    const anonymous = await browser.newContext({
      baseURL: "http://127.0.0.1:3107",
      viewport: { width: 1280, height: 900 },
    });
    try {
      const reader = await anonymous.newPage();
      await reader.goto(share.href);
      await expect(reader).toHaveTitle("Attention Is All You Need");
      await expect(
        reader.getByRole("heading", { name: "Attention Is All You Need" }),
      ).toBeVisible();
      await expect(
        reader.getByText("View only", { exact: true }),
      ).toBeVisible();
      await expect(
        reader.getByRole("button", { name: "Comment", exact: true }),
      ).toBeDisabled();
      await expect(
        reader.getByRole("button", { name: "Canvas", exact: true }),
      ).toBeDisabled();
      await expect(
        reader.getByRole("button", { name: "Save annotations in PDF" }),
      ).toBeDisabled();
      await expect(
        reader.getByRole("textbox", { name: "Ask about the paper" }),
      ).toBeDisabled();
      await expect(reader.getByRole("button", { name: "Send" })).toBeDisabled();
      await expect(
        reader.getByRole("combobox", { name: "Previous conversations" }),
      ).toContainText("Why attention replaced recurrence");
      await expect(reader.getByText("Page 1 of 3")).toBeVisible();
      await reader.keyboard.press("Control+f");
      const search = reader.getByRole("searchbox", { name: "Find in paper" });
      await search.fill("attention");
      await expect(
        reader.locator(".textLayer .highlight").first(),
      ).toBeVisible();
      await search.press("Escape");
      if (mode !== "view") {
        await reader
          .getByRole("button", { name: "Open in your Papernook" })
          .click();
        await expect(reader.getByLabel("Your Papernook address")).toBeVisible();
        await reader.getByRole("button", { name: "Close import" }).click();
      }
      await reader.getByRole("button", { name: "Hide header" }).click();
      await expect(
        reader.getByText("View only", { exact: true }),
      ).toBeVisible();
      await reader.setViewportSize({ width: 390, height: 844 });
      await expect(reader.getByRole("tab", { name: "Reading" })).toBeVisible();
      if (mode !== "view") {
        for (const width of [390, 500]) {
          await reader.setViewportSize({ width, height: 844 });
          await reader
            .getByRole("button", { name: "Open in your Papernook" })
            .click();
          const dialog = reader.getByRole("dialog", {
            name: "Open in your Papernook",
          });
          const bounds = await dialog.boundingBox();
          expect(bounds).not.toBeNull();
          expect(bounds!.x).toBeGreaterThanOrEqual(0);
          expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
          await expect(
            reader.getByLabel("Your Papernook address"),
          ).toBeVisible();
          await reader.getByRole("button", { name: "Close import" }).click();
        }
      }
      await reader.getByRole("tab", { name: "Chat" }).click();
      await expect(
        reader.getByRole("textbox", { name: "Ask about the paper" }),
      ).toBeDisabled();
      expect(
        (await reader.request.post(`${source}/chats`, { data: {} })).status(),
      ).toBe(401);
    } finally {
      await anonymous.close();
      await page.request.delete(`${source}/shares/${share.id}`);
      shareId = null;
    }
  }
});

test("shared readers switch between published conversations without exposing private chats", async ({
  page,
  browser,
}) => {
  const chatDir = path.join(
    process.cwd(),
    ".playwright-data",
    "library",
    "machine-learning",
    "attention-is-all-you-need",
    "chats",
    "maya",
  );
  const sharedChat = path.join(chatDir, "fedcba9876543210.jsonl");
  const privateChat = path.join(chatDir, "aaaaaaaaaaaaaaaa.jsonl");
  const fixture = (id: string, title: string, content: string) =>
    [
      JSON.stringify({
        id,
        title,
        titleSource: "manual",
        username: "maya",
        createdAt: "2026-07-18T12:30:00.000Z",
      }),
      JSON.stringify({ role: "user", content, at: "2026-07-18T12:31:00.000Z" }),
    ].join("\n") + "\n";
  await fs.writeFile(
    sharedChat,
    fixture(
      "fedcba9876543210",
      "Second reading",
      "A published second question",
    ),
  );
  await fs.writeFile(
    privateChat,
    fixture("aaaaaaaaaaaaaaaa", "Private reading", "A private question"),
  );
  try {
    const created = await page.request.post(`${source}/shares`, {
      data: { mode: "view", chatIds: ["0123456789abcdef", "fedcba9876543210"] },
    });
    expect(created.ok(), await created.text()).toBe(true);
    const { share } = await created.json();
    shareId = share.id;
    const anonymous = await browser.newContext({
      baseURL: "http://127.0.0.1:3107",
    });
    try {
      const reader = await anonymous.newPage();
      await reader.goto(share.href);
      await expect(
        reader.getByText("Why was removing recurrence such a big deal?"),
      ).toBeVisible();
      const select = reader.getByRole("combobox", {
        name: "Previous conversations",
      });
      await select.selectOption("fedcba9876543210");
      await expect(
        reader.getByText("A published second question"),
      ).toBeVisible();
      await expect(
        reader.getByText("Why was removing recurrence such a big deal?"),
      ).toHaveCount(0);
      await expect(select).not.toContainText("Private reading");
      await expect(reader.getByText("A private question")).toHaveCount(0);
      expect(await reader.content()).not.toContain("A private question");
    } finally {
      await anonymous.close();
    }
  } finally {
    await fs.rm(sharedChat, { force: true });
    await fs.rm(privateChat, { force: true });
  }
});

test("forks annotated readings without establishing an upstream connection", async ({
  page,
}) => {
  const created = await page.request.post(`${source}/shares`, {
    data: { mode: "fork", chatIds: ["0123456789abcdef"] },
  });
  expect(created.ok()).toBe(true);
  const { share } = await created.json();
  shareId = share.id;
  await page.goto(
    `/sharing/import?url=${encodeURIComponent(`https://127.0.0.1:3148${share.href}`)}`,
  );
  await page.getByLabel("Topic", { exact: true }).fill("shared-forks");
  await page.getByRole("button", { name: "Import independent fork" }).click();
  await expect(page).toHaveURL(/\/paper\/shared-forks\//, { timeout: 30_000 });
  copyPath = new URL(page.url()).pathname;
  const copyBase = copyPath.replace("/paper/", "/api/v1/papers/");
  expect(await (await page.request.get(`${copyBase}/pdf`)).body()).toEqual(
    originalPdf,
  );
  const chats = await (await page.request.get(`${copyBase}/chats`)).json();
  expect(
    chats.chats.some((chat: { title: string }) => chat.title.includes("Maya")),
  ).toBe(true);
  const state = await (
    await page.request.get(`${copyBase}/collaboration`)
  ).json();
  expect(state.connected).toBe(false);
  await page.request.delete(`${source}/shares/${shareId}`);
  shareId = null;
  expect((await page.request.get(`${copyBase}/pdf`)).ok()).toBe(true);
});

test("requires approval, attributes shared annotations, publishes chats and enforces revocation", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const created = await page.request.post(`${source}/shares`, {
    data: {
      mode: "collaborate",
      chatIds: [],
      acknowledgePublicAnnotations: true,
    },
  });
  expect(created.ok()).toBe(true);
  const { share } = await created.json();
  shareId = share.id;
  await page.goto(
    `/sharing/import?mode=collaborate&url=${encodeURIComponent(`https://127.0.0.1:3148${share.href}`)}`,
  );
  await page.getByLabel("Topic", { exact: true }).fill("shared-work");
  await page.getByRole("checkbox", { name: /I understand/ }).check();
  await page.getByRole("button", { name: "Import and request access" }).click();
  await expect(page).toHaveURL(/\/paper\/shared-work\//, { timeout: 30_000 });
  copyPath = new URL(page.url()).pathname;
  const copyBase = copyPath.replace("/paper/", "/api/v1/papers/");
  await expect(page.getByText(/Your verification code:/)).toBeVisible({
    timeout: 30_000,
  });
  expect((await page.request.get(`${copyBase}/pdf`)).status()).toBe(403);
  const participants = await (
    await page.request.get(`${source}/shares/${shareId}/participants`)
  ).json();
  const participant = participants.participants.find(
    (p: { status: string }) => p.status === "pending",
  );
  expect(participant.id).toMatch(/^[a-f0-9]{16}$/);
  expect(
    (
      await page.request.patch(`${source}/shares/${shareId}/participants`, {
        data: {
          id: participant.id,
          status: "approved",
          name: "Maya Collaborator",
        },
      })
    ).ok(),
  ).toBe(true);
  // Import and the preceding fixture restoration are external writes from the
  // reader's perspective. Respect the same recent-write guard as WebDAV.
  await new Promise((resolve) => setTimeout(resolve, 5200));
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Comment", exact: true }),
  ).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Text", exact: true }).click();
  await page
    .locator(".pdfViewer .page")
    .first()
    .click({ position: { x: 300, y: 180 } });
  const editor = page.locator(".freeTextEditor .internal").first();
  await expect(editor).toBeVisible();
  await page.keyboard.type("A collaboratively saved text annotation");
  await page.getByRole("button", { name: "Select", exact: true }).click();
  await saveAnnotations(page, copyBase);
  const first = annotationValues(
    await PDFDocument.load(
      await (await page.request.get(`${source}/pdf`)).body(),
    ),
  ).find(
    (annotation) =>
      annotation.content === "A collaboratively saved text annotation",
  )!;
  expect(first.author).toBe("Maya Collaborator");
  await page.getByRole("button", { name: "Text", exact: true }).click();
  const existingEditor = page
    .locator(".freeTextEditor .internal")
    .filter({ hasText: "A collaboratively saved text annotation" });
  await expect(existingEditor).toBeVisible();
  await page
    .locator(".freeTextEditor")
    .filter({ hasText: "A collaboratively saved text annotation" })
    .dblclick();
  await expect(existingEditor).toHaveAttribute("contenteditable", "true");
  await existingEditor.fill("An updated collaborative annotation");
  await page.getByRole("button", { name: "Select", exact: true }).click();
  await saveAnnotations(page, copyBase);
  await page.getByRole("button", { name: "Draw", exact: true }).click();
  const box = (await page.locator(".pdfViewer .page").first().boundingBox())!;
  await page.mouse.move(box.x + 260, box.y + 240);
  await page.mouse.down();
  await page.mouse.move(box.x + 310, box.y + 260, { steps: 6 });
  await page.mouse.up();
  await page.getByRole("button", { name: "Select", exact: true }).click();
  await saveAnnotations(page, copyBase);
  const thirdResponse = await page.request.get(`${source}/pdf`);
  const thirdBytes = await thirdResponse.body();
  const third = annotationValues(await PDFDocument.load(thirdBytes));
  expect(
    third.filter(
      (annotation) =>
        annotation.content === "An updated collaborative annotation",
    ),
  ).toEqual([
    expect.objectContaining({
      name: first.name,
      author: "Maya Collaborator",
      actor: `participant:${participant.id}`,
    }),
  ]);
  expect(
    third.some(
      (annotation) =>
        annotation.type === "/Ink" && annotation.author === "Maya Collaborator",
    ),
  ).toBe(true);
  const unchanged = await page.request.put(`${copyBase}/pdf`, {
    headers: {
      "Content-Type": "application/pdf",
      "If-Match": thirdResponse.headers().etag,
    },
    data: thirdBytes,
  });
  expect(unchanged.ok(), await unchanged.text()).toBe(true);
  expect((await unchanged.json()).etag).toBe(thirdResponse.headers().etag);
  await page.getByRole("button", { name: "Text", exact: true }).click();
  const leavingEditor = page
    .locator(".freeTextEditor")
    .filter({ hasText: "An updated collaborative annotation" });
  await leavingEditor.dblclick();
  await leavingEditor
    .locator(".internal")
    .fill("Saved while leaving the reader");
  await page
    .getByRole("link", { name: /Library/ })
    .first()
    .click();
  await expect(page).toHaveURL("/", { timeout: 30_000 });
  const afterLeaving = annotationValues(
    await PDFDocument.load(
      await (await page.request.get(`${source}/pdf`)).body(),
    ),
  );
  expect(afterLeaving).toContainEqual(
    expect.objectContaining({
      content: "Saved while leaving the reader",
      name: first.name,
    }),
  );
  await page.goto(copyPath);
  await expect(
    page.getByRole("button", { name: "Comment", exact: true }),
  ).toBeVisible({ timeout: 30_000 });
  const opened = await page.request.get(`${copyBase}/pdf`);
  expect(opened.ok()).toBe(true);
  const saved = await page.request.post(`${copyBase}/comments`, {
    headers: { "If-Match": opened.headers().etag },
    data: {
      action: "create",
      page: 1,
      x: 100,
      y: 100,
      text: "A note from the approved collaborator",
    },
  });
  expect(saved.ok(), await saved.text()).toBe(true);
  const sourcePdf = await (await page.request.get(`${source}/pdf`)).body();
  const document = await PDFDocument.load(sourcePdf);
  const note = annotationValues(document).find(
    (value) => value.content === "A note from the approved collaborator",
  );
  expect(note).toMatchObject({
    author: "Maya Collaborator",
    actor: `participant:${participant.id}`,
  });
  const { chat } = await (
    await page.request.post(`${copyBase}/chats`, { data: {} })
  ).json();
  const [, , topic, slug] = copyPath.split("/");
  await fs.appendFile(
    path.join(
      process.cwd(),
      ".playwright-data/library",
      topic,
      slug,
      "chats/maya",
      `${chat.id}.jsonl`,
    ),
    JSON.stringify({
      role: "user",
      content: "A conversation explicitly shared with collaborators",
      at: new Date().toISOString(),
    }) + "\n",
  );
  expect(
    (
      await page.request.post(`${copyBase}/collaboration`, {
        data: { chatId: chat.id },
      })
    ).ok(),
  ).toBe(true);
  await page.reload();
  await expect(page.getByText(/Your verification code:/)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Text", exact: true }),
  ).toBeEnabled();
  await expect(page.locator(".pdfViewer .page canvas").first()).toBeVisible();
  await expect(page).toHaveScreenshot(["product", "collaboration.png"], {
    animations: "disabled",
    maxDiffPixelRatio: 0.06,
  });
  const sourceSharing = await (
    await page.request.get(`${source}/collaboration`)
  ).json();
  expect(
    sourceSharing.threads.some(
      (thread: { author: string; chat: { messages: { content: string }[] } }) =>
        thread.author === "Maya Collaborator" &&
        thread.chat.messages.some((message) =>
          message.content.includes("explicitly shared"),
        ),
    ),
  ).toBe(true);
  await page.goto(share.href);
  await expect(page.getByText("View only", { exact: true })).toBeVisible();
  await expect(page.getByRole("textbox")).toHaveCount(1);
  await expect(
    page.getByRole("button", { name: "Comment", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByText("A conversation explicitly shared with collaborators"),
  ).toHaveCount(0);
  expect(
    (
      await page.request.patch(`${source}/shares/${shareId}/participants`, {
        data: { id: participant.id, status: "revoked" },
      })
    ).ok(),
  ).toBe(true);
  expect((await page.request.get(`${copyBase}/pdf`)).status()).toBe(403);
});

test("rejects an unauthorized upload before buffering its unfinished body", async ({
  page,
}) => {
  const created = await page.request.post(`${source}/shares`, {
    data: {
      mode: "collaborate",
      chatIds: [],
      acknowledgePublicAnnotations: true,
    },
  });
  const { share } = await created.json();
  shareId = share.id;
  const cookie = (await page.context().cookies())
    .map(({ name, value }) => `${name}=${value}`)
    .join("; ");
  for (const attempt of [
    {
      topic: "machine-learning",
      headers: { Authorization: "Bearer invalid" },
      status: 401,
    },
    { topic: "machine-learning", headers: { Cookie: cookie }, status: 401 },
    {
      topic: "INVALID",
      headers: { Authorization: "Bearer invalid" },
      status: 404,
    },
    {
      topic: "machine-learning",
      headers: {
        Origin: "https://attacker.example",
        "Sec-Fetch-Site": "cross-site",
      },
      status: 403,
    },
  ]) {
    const status = await new Promise<number>((resolve, reject) => {
      const request = http.request(
        {
          host: "127.0.0.1",
          port: 3107,
          path: `/api/v1/shares/${attempt.topic}/attention-is-all-you-need/${share.id}/exchange`,
          method: "POST",
          headers: {
            ...attempt.headers,
            "X-Sharing-Operation": "save-pdf",
            "Content-Type": "application/json",
            "Content-Length": "100000000",
          },
        },
        (response) => {
          clearTimeout(deadline);
          resolve(response.statusCode ?? 500);
          response.resume();
          request.destroy();
        },
      );
      const deadline = setTimeout(() => {
        request.destroy();
        reject(
          new Error("The server buffered an unauthorized unfinished upload."),
        );
      }, 10_000);
      request.on("error", (error) => {
        clearTimeout(deadline);
        reject(error);
      });
      request.write(" ".repeat(1024));
    });
    expect(status).toBe(attempt.status);
  }
});

test("copies an existing link until a new snapshot is explicitly created", async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  const chatFile = path.join(
    process.cwd(),
    ".playwright-data",
    "library",
    "machine-learning",
    "attention-is-all-you-need",
    "chats",
    "maya",
    "eeeeeeeeeeeeeeee.jsonl",
  );
  const createdIds: string[] = [];
  const firstMessage = "The first snapshot includes this question.";
  const laterMessage = "This question was added after the first link.";
  await fs.writeFile(
    chatFile,
    [
      JSON.stringify({
        id: "eeeeeeeeeeeeeeee",
        title: "Snapshot freshness",
        titleSource: "manual",
        username: "maya",
        createdAt: "2026-07-18T12:30:00.000Z",
      }),
      JSON.stringify({
        role: "user",
        content: firstMessage,
        at: "2026-07-18T12:31:00.000Z",
      }),
    ].join("\n") + "\n",
    { flag: "wx" },
  );
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  const readShares = async () => {
    const response = await page.request.get(`${source}/shares`);
    expect(response.ok()).toBe(true);
    return (await response.json()).shares as { id: string; href: string }[];
  };
  const createLink = async () => {
    const response = page.waitForResponse(
      (item) =>
        item.request().method() === "POST" &&
        item.url().endsWith(`${source}/shares`),
    );
    await page.getByRole("button", { name: "Create link & copy" }).click();
    const result = await response;
    expect(result.ok(), await result.text()).toBe(true);
    const { share } = (await result.json()) as {
      share: { id: string; href: string };
    };
    createdIds.push(share.id);
    return share;
  };
  try {
    await page.goto("/paper/machine-learning/attention-is-all-you-need");
    await page.getByRole("button", { name: "Share", exact: true }).click();
    await expect(page.getByText("Loading sharing options…")).toBeHidden();
    const newLink = page.getByRole("button", { name: "Create a new link" });
    if (await newLink.isVisible()) await newLink.click();
    await page
      .getByRole("checkbox", { name: /Include canvas and exercise snapshots/ })
      .check();
    await page
      .getByRole("checkbox", { name: /Include conversation snapshots/ })
      .check();
    await expect(
      page.getByRole("dialog").getByText("Snapshot freshness", { exact: true }),
    ).toBeVisible();
    const first = await createLink();
    const sharesAfterCreation = await readShares();
    const firstRow = page
      .getByRole("dialog")
      .locator("li")
      .filter({ has: page.locator(`a[href="${first.href}"]`) });
    await expect(
      firstRow.getByRole("button", { name: "Copied" }),
    ).toBeVisible();
    await expect(firstRow).toContainText("canvas and exercises");
    await expect(firstRow).toContainText("Snapshot freshness");
    await page.getByRole("button", { name: "Close sharing dialog" }).click();
    await page.getByRole("button", { name: "Share", exact: true }).click();
    await firstRow.getByRole("button", { name: /^(Copy|Copied)$/ }).click();
    await expect(
      firstRow.getByRole("button", { name: "Copied" }),
    ).toBeVisible();
    expect(await readShares()).toEqual(sharesAfterCreation);

    await fs.appendFile(
      chatFile,
      JSON.stringify({
        role: "user",
        content: laterMessage,
        at: "2026-07-18T12:32:00.000Z",
      }) + "\n",
    );
    await page.getByRole("button", { name: "Create a new link" }).click();
    await page
      .getByRole("checkbox", { name: /Include conversation snapshots/ })
      .check();
    const second = await createLink();
    expect(second.id).not.toBe(first.id);
    expect((await readShares()).map((share) => share.id)).toEqual(
      expect.arrayContaining([first.id, second.id]),
    );
    const secondRow = page
      .getByRole("dialog")
      .locator("li")
      .filter({ has: page.locator(`a[href="${second.href}"]`) });
    await expect(secondRow).toContainText("Snapshot freshness");
    await expect(secondRow).not.toContainText("canvas and exercises");

    await page.getByRole("button", { name: "Create a new link" }).click();
    await page.getByRole("radio", { name: /Collaborate/ }).check();
    const acknowledgment = page.getByRole("checkbox", {
      name: /Share the same annotated PDF/,
    });
    const create = page.getByRole("button", { name: "Create link & copy" });
    await expect(acknowledgment).not.toBeChecked();
    await expect(create).toBeDisabled();
    await acknowledgment.check();
    await createLink();
    await page.getByRole("button", { name: "Create a new link" }).click();
    await expect(page.getByRole("radio", { name: /View only/ })).toBeChecked();
    await expect(
      page.getByRole("checkbox", {
        name: /Include canvas and exercise snapshots/,
      }),
    ).not.toBeChecked();
    await expect(
      page.getByRole("checkbox", { name: /Include conversation snapshots/ }),
    ).not.toBeChecked();
    await page.getByRole("radio", { name: /Collaborate/ }).check();
    await expect(acknowledgment).not.toBeChecked();
    await expect(create).toBeDisabled();

    const anonymous = await browser.newContext({
      baseURL: "http://127.0.0.1:3107",
    });
    try {
      const reader = await anonymous.newPage();
      for (const [share, includesLater] of [
        [first, false],
        [second, true],
      ] as const) {
        await reader.goto(share.href);
        await expect(
          reader.getByText("View only. New messages are disabled."),
        ).toBeVisible();
        await expect(
          reader.getByRole("textbox", { name: "Ask about the paper" }),
        ).toBeDisabled();
        await expect(
          reader.getByRole("button", { name: "Send" }),
        ).toBeDisabled();
        await reader
          .getByRole("combobox", { name: "Previous conversations" })
          .selectOption("eeeeeeeeeeeeeeee");
        await expect(reader.getByText(firstMessage)).toBeVisible();
        if (includesLater)
          await expect(reader.getByText(laterMessage)).toBeVisible();
        else await expect(reader.getByText(laterMessage)).toHaveCount(0);
      }
    } finally {
      await anonymous.close();
    }
  } finally {
    for (const id of createdIds)
      await page.request.delete(`${source}/shares/${id}`);
    await fs.rm(chatFile, { force: true });
  }
});

test("keeps sharing choices usable on a narrow screen", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/paper/machine-learning/attention-is-all-you-need");
  await page.getByRole("button", { name: "Share", exact: true }).click();
  await page.getByRole("radio", { name: /Collaborate/ }).check();
  const create = page.getByRole("button", { name: "Create link & copy" });
  await expect(create).toBeDisabled();
  await page
    .getByRole("checkbox", { name: /Share the same annotated PDF/ })
    .check();
  await expect(create).toBeEnabled();
  await expect(page.getByRole("dialog")).toBeVisible();
  expect(
    await page
      .getByRole("dialog")
      .evaluate((dialog) => dialog.scrollWidth <= dialog.clientWidth),
  ).toBe(true);
  expect(
    await page
      .getByRole("dialog")
      .locator("small, p")
      .evaluateAll((elements) =>
        elements.every((element) => element.scrollWidth <= element.clientWidth),
      ),
  ).toBe(true);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await expect(page).toHaveScreenshot(["product", "share-reading-mobile.png"], {
    animations: "disabled",
    maxDiffPixelRatio: 0.06,
  });
});
