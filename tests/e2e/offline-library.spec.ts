import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium, expect, test, type Page } from "@playwright/test";

const paperPath = "/paper/machine-learning/attention-is-all-you-need";
const paperTitle = "Attention Is All You Need";
const conversationTitle = "Offline Unicode study";

function sessionResponseBoundary(response: {
  status: number;
  body: string;
}): void {
  const original = window.fetch.bind(window);
  window.fetch = (...args) =>
    String(args[0]).endsWith("/api/v1/session")
      ? Promise.resolve(
          new Response(response.body, {
            status: response.status,
            headers: { "Content-Type": "application/json" },
          }),
        )
      : original(...args);
}

async function login(page: Page): Promise<void> {
  await page.goto("/login");
  await expect
    .poll(
      () =>
        page
          .evaluate(() => Boolean(navigator.serviceWorker.controller))
          .catch(() => false),
      { timeout: 60_000 },
    )
    .toBe(true);
  await page
    .getByRole("textbox", { name: "Password" })
    .fill("admin-created-password");
  await page.getByRole("button", { name: "Enter" }).click();
  await page.getByRole("button", { name: "Switch to Maya" }).click();
  await expect(page).toHaveURL("/");
  await expect
    .poll(() =>
      page.evaluate(() => Boolean(navigator.serviceWorker.controller)),
    )
    .toBe(true);
}

async function download(page: Page, url: string): Promise<void> {
  await page.goto(url);
  const snapshot = page.waitForResponse((response) =>
    response.url().includes("/api/v1/offline/"),
  );
  await page
    .getByRole("button", { name: "Available offline", exact: true })
    .click();
  const response = await snapshot;
  expect(response.ok(), response.ok() ? "" : await response.text()).toBe(true);
  await expect(
    page.getByRole("button", { name: "Update offline download", exact: true }),
  ).toBeEnabled({ timeout: 60_000 });
}

async function importConversation(page: Page): Promise<string> {
  const response = await page.request.post("/api/v1/conversations", {
    data: {
      title: conversationTitle,
      topic: "machine-learning",
      format: "markdown",
      content:
        "# User\n\nExplain café and 你好.\n\n# Assistant\n\nPreserved Unicode café 你好.\n\n| Value | Result |\n| --- | --- |\n| alpha | beta |\n\n$x^2$\n\n```python\nprint('preserved')\n```",
    },
  });
  expect(response.ok(), await response.text()).toBe(true);
  const { conversation } = (await response.json()) as {
    conversation: { id: string };
  };
  return `/conversations/${conversation.id}`;
}

test.describe("downloaded library", () => {
  test.use({ serviceWorkers: "allow" });
  test.setTimeout(120_000);

  test("offline saving stays available with hidden headers on papers and conversations", async ({
    page,
  }) => {
    await login(page);
    const conversationPath = await importConversation(page);
    try {
      for (const url of [paperPath, conversationPath]) {
        await page.setViewportSize({ width: 1000, height: 900 });
        await page.goto(url);
        const hideHeader = page.getByRole("button", {
          name: "Hide header",
          exact: true,
        });
        await hideHeader.click();
        await page
          .getByRole("button", { name: "Available offline", exact: true })
          .click();
        const update = page.getByRole("button", {
          name: "Update offline download",
          exact: true,
        });
        await expect(update).toBeEnabled({ timeout: 60_000 });
        await expect(
          page.getByRole("link", { name: "Saved on this device", exact: true }),
        ).toBeVisible();
        await page
          .getByRole("button", { name: "Focus reading", exact: true })
          .click();
        await expect(update).toBeVisible();
        await page.setViewportSize({ width: 390, height: 844 });
        await expect(update).toBeVisible();
        await page.getByRole("tab", { name: "Chat", exact: true }).click();
        await expect(update).toBeVisible();
        await page.setViewportSize({ width: 1000, height: 900 });
        await page
          .getByRole("button", { name: "Show chat", exact: true })
          .click();
        await page
          .getByRole("button", { name: "Show header", exact: true })
          .click();
      }
    } finally {
      await page.request.delete(`/api/v1${conversationPath}`);
    }
  });

  test("downloaded paper and chat survive a complete Chromium browser restart", async ({
    browserName,
    baseURL,
  }) => {
    test.skip(
      browserName !== "chromium",
      "Persistent Chromium restart journey; the remaining offline journeys also run in WebKit.",
    );
    const userDataDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "papernook-browser-restart-"),
    );
    let browser = await chromium.launchPersistentContext(userDataDir, {
      headless: true,
      baseURL,
      serviceWorkers: "allow",
    });
    try {
      const page = await browser.newPage();
      await login(page);
      await download(page, paperPath);
      await browser.close();
      browser = await chromium.launchPersistentContext(userDataDir, {
        headless: true,
        baseURL,
        serviceWorkers: "allow",
        offline: true,
      });
      const reader = await browser.newPage();
      await reader.goto(paperPath);
      await expect(
        reader.getByRole("heading", { name: paperTitle }),
      ).toBeVisible();
      await expect(reader.getByLabel("Downloaded PDF page")).toBeVisible();
      await reader
        .getByRole("button", {
          name: "Why attention replaced recurrence",
          exact: true,
        })
        .click();
      await expect(
        reader
          .frameLocator("iframe")
          .getByText(/Every token can connect directly/),
      ).toBeVisible();
    } finally {
      await browser.close();
      await fs.rm(userDataDir, { recursive: true, force: true });
    }
  });

  test("losing connectivity preserves a typed conversation draft and disables sending", async ({
    page,
    context,
  }) => {
    await login(page);
    const conversationPath = await importConversation(page);
    await page.goto(conversationPath);
    const draft = "Keep my unsent question about attention α";
    await page
      .getByRole("textbox", { name: "Question", exact: true })
      .fill(draft);
    await expect(
      page.getByRole("button", { name: "Send", exact: true }),
    ).toBeEnabled();
    await context.setOffline(true);
    await expect(
      page.getByRole("button", { name: "Send", exact: true }),
    ).toBeDisabled();
    await expect(
      page.getByRole("textbox", { name: "Question", exact: true }),
    ).toHaveValue(draft);
    await expect(page).toHaveURL(conversationPath);
    await context.setOffline(false);
    await expect(
      page.getByRole("button", { name: "Send", exact: true }),
    ).toBeEnabled();
    await expect(
      page.getByRole("textbox", { name: "Question", exact: true }),
    ).toHaveValue(draft);
    await page.request.delete(`/api/v1${conversationPath}`);
  });

  test("removing a download while its refresh checks the session cannot resurrect it", async ({
    page,
  }) => {
    await login(page);
    await download(page, paperPath);
    await page.goto("/offline/index.html");
    await expect(page.locator("#status")).toContainText("Connected");
    await page.evaluate(() => {
      const original = window.fetch.bind(window);
      const gate = { paused: false, release: () => {} };
      const resume = new Promise<void>((resolve) => {
        gate.release = resolve;
      });
      Object.assign(window, { sessionGate: gate });
      window.fetch = async (...args) => {
        const response = await original(...args);
        if (!gate.paused && String(args[0]).endsWith("/api/v1/session")) {
          gate.paused = true;
          await resume;
        }
        return response;
      };
    });
    await page
      .getByRole("button", { name: "Update download", exact: true })
      .click();
    try {
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              (window as unknown as { sessionGate: { paused: boolean } })
                .sessionGate.paused,
          ),
        )
        .toBe(true);
      await page
        .getByRole("button", { name: "Remove download", exact: true })
        .click();
      await expect(page.locator("#storage")).toContainText("0 downloads");
    } finally {
      await page.evaluate(() =>
        (
          window as unknown as { sessionGate: { release: () => void } }
        ).sessionGate.release(),
      );
    }
    await expect(page.getByRole("alert")).toContainText(
      /changed|cancelled|removed/i,
    );
    await page.reload();
    await expect(page.locator("#storage")).toContainText("0 downloads");
    await expect(
      page.getByRole("button", { name: paperTitle, exact: true }),
    ).toHaveCount(0);
  });

  test("server failure opens the saved paper while the browser remains online", async ({
    page,
  }) => {
    await login(page);
    await download(page, paperPath);
    const response = {
      status: 503,
      body: JSON.stringify({ error: "Server unavailable" }),
    };
    await page.addInitScript(sessionResponseBoundary, response);
    await page.evaluate(sessionResponseBoundary, response);
    expect(await page.evaluate(() => navigator.onLine)).toBe(true);
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await expect(page).toHaveURL(/\/offline\/index\.html\?return=/);
    await expect(page.getByLabel("Downloaded PDF page")).toBeVisible();
    await expect(page.getByRole("heading", { name: paperTitle })).toBeVisible();
  });

  test("a successful session response without a profile invalidates saved content", async ({
    page,
    context,
  }) => {
    await login(page);
    await download(page, paperPath);
    const saved = await context.newPage();
    await saved.goto("/offline/index.html");
    await saved.getByRole("button", { name: paperTitle, exact: true }).click();
    await expect(saved.getByLabel("Downloaded PDF page")).toBeVisible();
    await page.evaluate(sessionResponseBoundary, {
      status: 200,
      body: JSON.stringify({ profile: null }),
    });
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await expect(page).toHaveURL("/login");
    await expect(saved.getByLabel("Downloaded PDF page")).toHaveCount(0);
    await expect(saved.getByRole("heading", { name: paperTitle })).toHaveCount(
      0,
    );
  });

  test("denied browser storage does not prevent signing in", async ({
    page,
  }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window, "indexedDB", {
        configurable: true,
        get() {
          throw new DOMException("Storage denied", "SecurityError");
        },
      });
    });
    await login(page);
    await expect(
      page.getByRole("button", { name: "Account menu for Maya" }),
    ).toBeVisible();
    await page.goto(paperPath);
    await page
      .getByRole("button", { name: "Available offline", exact: true })
      .click();
    await expect(
      page.getByRole("alert").filter({ hasText: /storage|download/i }),
    ).toBeVisible();
    await expect(page.getByRole("heading", { name: paperTitle })).toBeVisible();
  });

  test("cold boot renders downloaded PDF and saved chat, then returns online", async ({
    page,
    context,
    browserName,
  }) => {
    test.skip(
      browserName === "webkit",
      "Playwright WebKit offline emulation fails cached service-worker navigations with an internal error, including a minimal standalone reproduction.",
    );
    await login(page);
    await download(page, paperPath);
    await page.close();
    await context.setOffline(true);
    const reader = await context.newPage();
    await reader.goto(paperPath);
    await expect(
      reader.getByRole("heading", { name: paperTitle }),
    ).toBeVisible();
    const canvas = reader.getByLabel("Downloaded PDF page");
    await expect(canvas).toBeVisible();
    await expect
      .poll(() =>
        canvas.evaluate((element) => {
          const canvas = element as HTMLCanvasElement;
          const pixels = canvas
            .getContext("2d")!
            .getImageData(0, 0, canvas.width, canvas.height).data;
          let ink = false;
          let paper = false;
          for (let offset = 0; offset < pixels.length; offset += 4) {
            if (pixels[offset + 3] !== 255) continue;
            if (pixels[offset] < 100) ink = true;
            if (pixels[offset] > 240) paper = true;
            if (ink && paper) return true;
          }
          return false;
        }),
      )
      .toBe(true);
    await reader
      .getByRole("button", {
        name: "Why attention replaced recurrence",
        exact: true,
      })
      .click();
    await expect(
      reader
        .frameLocator("iframe")
        .getByText("Why was removing recurrence such a big deal?", {
          exact: true,
        }),
    ).toBeVisible();
    await expect(
      reader
        .frameLocator("iframe")
        .getByText(/Every token can connect directly/),
    ).toBeVisible();
    await expect(
      reader.getByRole("button", { name: "Send", exact: true }),
    ).toHaveCount(0);
    await context.setOffline(false);
    await expect(reader).toHaveURL(paperPath, { timeout: 25_000 });
  });

  test("conversation and paper categories stay separate and device removal preserves server documents", async ({
    page,
    context,
    browserName,
  }) => {
    test.skip(
      browserName === "webkit",
      "Playwright WebKit offline emulation fails cached service-worker navigations with an internal error, including a minimal standalone reproduction.",
    );
    await login(page);
    const conversationPath = await importConversation(page);
    await download(page, paperPath);
    await download(page, conversationPath);
    await page.close();
    await context.setOffline(true);
    const reader = await context.newPage();
    await reader.goto("/offline/index.html");
    await expect(
      reader.getByRole("button", { name: paperTitle, exact: true }),
    ).toBeVisible();
    await expect(
      reader.getByRole("button", { name: conversationTitle, exact: true }),
    ).toHaveCount(0);
    await reader
      .getByRole("button", { name: "Conversations", exact: true })
      .click();
    await reader
      .getByLabel("Category", { exact: true })
      .selectOption("machine-learning");
    await expect(
      reader.getByRole("button", { name: paperTitle, exact: true }),
    ).toHaveCount(0);
    await reader
      .getByRole("button", { name: conversationTitle, exact: true })
      .click();
    const transcript = reader.frameLocator("iframe");
    await expect(
      transcript.getByText("Preserved Unicode café 你好.", { exact: true }),
    ).toBeVisible();
    await expect(transcript.locator("table")).toContainText("alpha");
    await expect(transcript.locator(".katex")).toBeVisible();
    await expect(transcript.locator("pre")).toContainText("print('preserved')");
    await reader
      .getByRole("button", { name: "← Downloads", exact: true })
      .click();
    await reader
      .getByRole("button", { name: "Remove download", exact: true })
      .click();
    await expect(
      reader.getByRole("button", { name: conversationTitle, exact: true }),
    ).toHaveCount(0);
    reader.once("dialog", (dialog) => dialog.accept());
    await reader
      .getByRole("button", { name: "Clear all downloads", exact: true })
      .click();
    await expect(reader.locator("#storage")).toContainText("0 downloads");
    await context.setOffline(false);
    await reader.goto(conversationPath);
    await expect(
      reader.getByRole("heading", { name: conversationTitle }),
    ).toBeVisible();
    const pdf = await reader.request.get(
      "/api/v1/papers/machine-learning/attention-is-all-you-need/pdf",
    );
    expect(pdf.status()).toBe(200);
    await reader.request.delete(`/api/v1${conversationPath}`);
  });

  test("switching profiles erases downloaded content in another open tab", async ({
    page,
    context,
  }) => {
    await login(page);
    await download(page, paperPath);
    const saved = await context.newPage();
    await saved.goto("/offline/index.html");
    await saved.getByRole("button", { name: paperTitle, exact: true }).click();
    await expect(saved.getByLabel("Downloaded PDF page")).toBeVisible();
    await page.goto("/");
    await page.getByRole("button", { name: "Account menu for Maya" }).click();
    await page
      .getByRole("link", { name: "Switch profile", exact: true })
      .click();
    await expect(
      saved.getByRole("heading", { name: "No offline profile" }),
    ).toBeVisible();
    await expect(saved.getByLabel("Downloaded PDF page")).toHaveCount(0);
    await page.getByRole("button", { name: "Switch to Maya" }).click();
    await expect(page).toHaveURL("/");
    await saved.reload();
    await expect(
      saved.getByRole("button", { name: paperTitle, exact: true }),
    ).toHaveCount(0);
  });
});
