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
                content: `\`\`\`python\n${highlightedCode}\n\`\`\``,
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

async function showHistoryFixture(page: Page): Promise<void> {
  await page.route("**/api/v1/papers/**/chats**", async (route) => {
    if (route.request().method() !== "GET") {
      await route.continue();
      return;
    }
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith("/chats")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          chats: historyChats.map(({ id, title, createdAt }) => ({
            id,
            title,
            createdAt,
          })),
        }),
      });
      return;
    }
    const chat = historyChats.find(({ id }) =>
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
