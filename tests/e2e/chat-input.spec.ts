import { expect, test, type Page } from "@playwright/test";

const password = "admin-created-password";
const pasteShortcut = process.platform === "darwin" ? "Meta+V" : "Control+V";
const copyShortcut = process.platform === "darwin" ? "Meta+C" : "Control+C";

async function login(page: Page): Promise<void> {
  await page.goto("/login");
  await page.getByRole("textbox", { name: "Password" }).fill(password);
  await page.getByRole("button", { name: "Enter" }).click();
  await page.getByRole("button", { name: "Switch to Maya" }).click();
  await expect(page).toHaveURL("/");
}

const highlightedCode = [
  "def project(points: torch.Tensor) -> torch.Tensor:",
  "    # points: [batch, xyz]",
  "    return points[:, :2]",
].join("\n");
const codePermalink =
  "https://github.com/mesh-splatting/mesh-splatting/blob/0123456789abcdef0123456789abcdef01234567/train.py#L69-L71";

async function showCodeReply(page: Page): Promise<void> {
  await page.route(
    "**/api/v1/papers/**/chats/0123456789abcdef",
    async (route) => {
      if (route.request().method() !== "GET") {
        await route.continue();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          chat: {
            messages: [
              { role: "user", content: "Show the projection." },
              {
                role: "assistant",
                content: `The projection is implemented in [train.py#L69-L71](${codePermalink}).\n\n\`\`\`python\n${highlightedCode}\n\`\`\``,
              },
            ],
          },
        }),
      });
    },
  );
  await page.goto("/paper/machine-learning/attention-is-all-you-need");
}

const historyChats = [
  {
    id: "1111111111111111",
    title: "History controls",
    createdAt: "2026-07-20T12:00:00.000Z",
    messages: [
      { role: "user", content: "An older question about attention." },
      { role: "assistant", content: "An older answer." },
      { role: "user", content: "The most recent question about recurrence." },
      { role: "assistant", content: "The most recent answer." },
    ],
  },
  {
    id: "2222222222222222",
    title: "Other conversation",
    createdAt: "2026-07-19T12:00:00.000Z",
    messages: [
      { role: "user", content: "Only this other chat message." },
      { role: "assistant", content: "A separate answer." },
    ],
  },
  {
    id: "3333333333333333",
    title: "Empty conversation",
    createdAt: "2026-07-18T12:00:00.000Z",
    messages: [{ role: "assistant", content: "No question was sent here." }],
  },
];

async function showHistoryFixture(
  page: Page,
  options: { deleteFails?: boolean } = {},
): Promise<void> {
  let fixtureChats = historyChats.map((chat) => ({
    ...chat,
    messages: chat.messages.map((message) => ({ ...message })),
  }));
  await page.route("**/api/v1/papers/**/chats**", async (route) => {
    const method = route.request().method();
    const pathname = new URL(route.request().url()).pathname;
    if (method === "DELETE") {
      if (options.deleteFails) {
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: "Deliberate delete failure." }),
        });
        return;
      }
      fixtureChats = fixtureChats.filter(
        ({ id }) => !pathname.endsWith(`/chats/${id}`),
      );
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true }),
      });
      return;
    }
    if (method !== "GET") {
      await route.continue();
      return;
    }
    if (pathname.endsWith("/chats")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          chats: fixtureChats.map(({ id, title, createdAt }) => ({
            id,
            title,
            createdAt,
          })),
        }),
      });
      return;
    }
    const chat = fixtureChats.find(({ id }) =>
      pathname.endsWith(`/chats/${id}`),
    );
    if (!chat) {
      await route.continue();
      return;
    }
    const { messages, ...header } = chat;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ chat: { header, messages } }),
    });
  });
  await page.goto("/paper/machine-learning/attention-is-all-you-need");
  await expect(
    page
      .getByRole("paragraph")
      .filter({ hasText: /^The most recent question about recurrence\.$/ }),
  ).toBeVisible();
}

test("highlighted code copies exact indentation and punctuation", async ({
  context,
  page,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await login(page);
  await showCodeReply(page);

  await page.getByRole("button", { name: "Copy code" }).click();
  await expect(page.getByText("Copied", { exact: true })).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(highlightedCode);
});

test("repository permalinks are visibly linked beside their source excerpt", async ({
  page,
}) => {
  await login(page);
  await showCodeReply(page);

  const permalink = page.getByRole("link", { name: "train.py#L69-L71" });
  await expect(permalink).toHaveAttribute("href", codePermalink);
  await expect(permalink).toHaveAttribute("target", "_blank");
  await expect(permalink).toHaveCSS("text-decoration-line", "underline");
  await permalink.focus();
  await expect(permalink).toHaveCSS("outline-style", "solid");
  await expect(page.getByText(highlightedCode, { exact: true })).toBeVisible();
});

test("paper header copies the original source link", async ({
  context,
  page,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await login(page);
  await page.goto("/paper/machine-learning/attention-is-all-you-need");

  await page.getByRole("button", { name: "Copy original paper link" }).click();
  await expect(page.getByText("Copied", { exact: true })).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe("https://arxiv.org/abs/1706.03762");
});

test("code copy reports when clipboard access fails", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: () => Promise.reject(new Error("clipboard denied")),
      },
    });
  });
  await login(page);
  await showCodeReply(page);

  await page.getByRole("button", { name: "Copy code" }).click();
  await expect(page.getByText("Copy failed", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("status").filter({ hasText: "Code could not be copied." }),
  ).toHaveText("Code could not be copied.");
});

test("PDF text can be copied and the chat draft stays editable while answering", async ({
  context,
  page,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await login(page);
  await page.goto("/paper/machine-learning/attention-is-all-you-need");
  await expect(page.getByText("Page 1 of 3")).toBeVisible();
  await expect(page).toHaveTitle("Attention Is All You Need");

  const textLayer = page.locator(".textLayer").first();
  await expect(textLayer).toContainText("Attention Is All You Need");
  await textLayer.evaluate((element) => {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(element);
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
  await page.keyboard.press(copyShortcut);
  const copiedPdfText = await page.evaluate(() =>
    navigator.clipboard.readText(),
  );
  expect(copiedPdfText).toContain("Attention Is All You Need");

  let releaseResponse: (() => void) | undefined;
  const waitForRelease = new Promise<void>((resolve) => {
    releaseResponse = resolve;
  });
  await page.route("**/api/v1/papers/**/chats/*", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    await waitForRelease;
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "deliberate test delay" }),
    });
  });

  const input = page.getByPlaceholder(/Ask about the paper/);
  await input.fill("First question");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByRole("button", { name: "Send" })).toBeDisabled();
  await expect(input).toBeEnabled();

  await input.fill("draftx");
  await input.press("Backspace");
  await expect(input).toHaveValue("draft");
  await page.evaluate(() => navigator.clipboard.writeText(" pasted text"));
  await input.press(pasteShortcut);
  await expect(input).toHaveValue("draft pasted text");

  releaseResponse?.();
  await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();
});

test("keepalive-only responses do not create blank assistant cards", async ({
  page,
}) => {
  await login(page);
  let sent = false;
  let releaseReload: (() => void) | undefined;
  const waitForReload = new Promise<void>((resolve) => {
    releaseReload = resolve;
  });
  let markReloadStarted: (() => void) | undefined;
  const reloadStarted = new Promise<void>((resolve) => {
    markReloadStarted = resolve;
  });
  await page.route("**/api/v1/papers/**/chats/*", async (route) => {
    if (route.request().method() === "POST") {
      sent = true;
      await route.fulfill({
        status: 200,
        contentType: "text/plain",
        body: "\n",
      });
      return;
    }
    if (sent && route.request().method() === "GET") {
      markReloadStarted?.();
      await waitForReload;
    }
    await route.continue();
  });
  await page.goto("/paper/machine-learning/attention-is-all-you-need");

  const assistantCards = page.locator(
    '[data-message-role="assistant"]:visible',
  );
  const completedAnswers = await assistantCards.count();
  await expect(
    page.getByRole("button", { name: "Save as exercise" }),
  ).toHaveCount(0);
  const input = page.getByPlaceholder(/Ask about the paper/);
  await input.fill("Slow research question");
  await page.getByRole("button", { name: "Send" }).click();

  await reloadStarted;
  await expect(assistantCards).toHaveCount(completedAnswers);
  releaseReload?.();
});

test("arrow keys recall sent messages and restore the unsent draft", async ({
  page,
}) => {
  await login(page);
  await showHistoryFixture(page);

  const input = page.getByPlaceholder(/Ask about the paper/);
  await input.press("ArrowUp");
  await expect(input).toHaveValue("The most recent question about recurrence.");
  await input.press("ArrowUp");
  await expect(input).toHaveValue("An older question about attention.");
  await input.press("ArrowDown");
  await expect(input).toHaveValue("The most recent question about recurrence.");
  await input.press("ArrowDown");
  await expect(input).toHaveValue("");

  await input.fill("Keep this exact unsent draft.");
  await input.evaluate((element) => {
    const textarea = element as HTMLTextAreaElement;
    textarea.setSelectionRange(0, 0);
  });
  await input.press("ArrowUp");
  await expect(input).toHaveValue("The most recent question about recurrence.");
  await input.press("ArrowDown");
  await expect(input).toHaveValue("Keep this exact unsent draft.");

  await input.fill("First draft line\nSecond draft line");
  await input.evaluate((element) => {
    const textarea = element as HTMLTextAreaElement;
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  });
  await input.press("ArrowUp");
  await expect(input).toHaveValue("First draft line\nSecond draft line");
});

test("Ctrl+R searches only the active chat and Escape preserves the draft", async ({
  page,
}) => {
  await login(page);
  await showHistoryFixture(page);

  const input = page.getByPlaceholder(/Ask about the paper/);
  const dialog = page.getByRole("dialog", { name: "Search sent messages" });
  const search = page.getByRole("searchbox", { name: "Filter sent messages" });

  await input.fill("Draft before searching.");
  await input.press("Control+r");
  await expect(dialog).toBeVisible();
  await search.fill("older");
  await expect(
    page.getByRole("option", { name: "An older question about attention." }),
  ).toBeVisible();
  await search.press("Enter");
  await expect(dialog).toBeHidden();
  await expect(input).toHaveValue("An older question about attention.");

  await input.fill("Draft that Escape keeps exactly.");
  await input.press("Control+r");
  await search.fill("does not exist");
  await expect(
    page.getByText("No sent messages match that search."),
  ).toBeVisible();
  await search.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(input).toHaveValue("Draft that Escape keeps exactly.");

  await page
    .getByRole("combobox", { name: "Previous conversations" })
    .selectOption("2222222222222222");
  await expect(
    page
      .getByRole("paragraph")
      .filter({ hasText: /^Only this other chat message\.$/ }),
  ).toBeVisible();
  await input.fill("");
  await input.press("ArrowUp");
  await expect(input).toHaveValue("Only this other chat message.");
  await input.press("Control+r");
  await expect(
    page.getByRole("option", { name: "Only this other chat message." }),
  ).toBeVisible();
  await expect(
    page.getByRole("option", {
      name: "The most recent question about recurrence.",
    }),
  ).toHaveCount(0);
  await search.press("Escape");

  await page
    .getByRole("combobox", { name: "Previous conversations" })
    .selectOption("3333333333333333");
  await expect(page.getByText("No question was sent here.")).toBeVisible();
  await input.fill("Empty-chat draft.");
  await input.press("Control+r");
  await expect(
    page.getByText("No sent messages in this chat yet."),
  ).toBeVisible();
  await search.press("Escape");
  await expect(input).toHaveValue("Empty-chat draft.");
});

test("deleting conversations confirms, selects the next chat, and handles the last chat", async ({
  page,
}) => {
  await login(page);
  await showHistoryFixture(page);

  const select = page.getByRole("combobox", { name: "Previous conversations" });
  const deleteButton = page.getByRole("button", {
    name: "Delete conversation",
  });
  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toContain("History controls");
    await dialog.dismiss();
  });
  await deleteButton.click();
  await expect(select).toHaveValue("1111111111111111");

  page.once("dialog", (dialog) => dialog.accept());
  await deleteButton.click();
  await expect(select).toHaveValue("2222222222222222");
  await expect(
    page
      .getByRole("paragraph")
      .filter({ hasText: /^Only this other chat message\.$/ }),
  ).toBeVisible();

  page.once("dialog", (dialog) => dialog.accept());
  await deleteButton.click();
  await expect(select).toHaveValue("3333333333333333");

  page.once("dialog", (dialog) => dialog.accept());
  await deleteButton.click();
  await expect(select).toHaveValue("");
  await expect(deleteButton).toBeDisabled();
  await expect(select.locator("option")).toHaveText("No conversations yet");
});

test("a failed conversation deletion preserves the active chat", async ({
  page,
}) => {
  await login(page);
  await showHistoryFixture(page, { deleteFails: true });

  const select = page.getByRole("combobox", { name: "Previous conversations" });
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Delete conversation" }).click();

  await expect(
    page.getByRole("alert").filter({ hasText: "Deliberate delete failure." }),
  ).toHaveText("Deliberate delete failure.");
  await expect(select).toHaveValue("1111111111111111");
  await expect(
    page
      .getByRole("paragraph")
      .filter({ hasText: /^The most recent question about recurrence\.$/ }),
  ).toBeVisible();
});
