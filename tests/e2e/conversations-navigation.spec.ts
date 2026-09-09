import { expect, test, type Page } from "@playwright/test";

test("conversation reading shares paper focus controls and renders rich source content", async ({
  page,
}, testInfo) => {
  await login(page);
  await page.goto("/paper/machine-learning/attention-is-all-you-need");
  const paperInput = page.getByPlaceholder(
    "Ask about the paper… (paste screenshots here)",
  );
  const paperInputBorder = await paperInput.evaluate(
    (element) => getComputedStyle(element).borderColor,
  );
  const paperSendColor = await page
    .getByRole("button", { name: "Send", exact: true })
    .evaluate((element) => getComputedStyle(element).backgroundColor);
  const paperToolbarColor = await page
    .getByRole("button", { name: "Select", exact: true })
    .locator("../..")
    .evaluate((element) => getComputedStyle(element).backgroundColor);
  const scene =
    "const scene = new THREE.Scene(); scene.background = new THREE.Color('#234b3b'); const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.1, 100); camera.position.z = 4; const renderer = new THREE.WebGLRenderer(); renderer.setSize(innerWidth, innerHeight); document.body.appendChild(renderer.domElement); scene.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshNormalMaterial())); renderer.render(scene, camera);";
  const response = await page.request.post("/api/v1/conversations", {
    data: {
      title: "Understanding attention, one step at a time",
      topic: "machine-learning",
      tags: ["attention", "study-notes"],
      format: "json",
      content: JSON.stringify({
        messages: [
          {
            role: "user",
            content:
              "How does attention connect the tokens in a sentence? Show the mathematics and an interactive example.",
          },
          {
            role: "assistant",
            content:
              "## Every token has a different perspective\n\nAttention lets each token gather information from the rest of the sequence. The weights tell us which relationships matter most.\n\n" +
              String.raw`\[\operatorname{Attention}(Q,K,V)=\operatorname{softmax}\left(\frac{QK^T}{\sqrt{d_k}}\right)V\]` +
              "\n\n| Matrix | Purpose |\n| --- | --- |\n| Q | Queries |\n| K | Keys |\n| V | Values |\n\n```python\nweights = softmax(queries @ keys.T)\n```\n\n```threejs\n" +
              scene +
              "\n```",
          },
          ...Array.from({ length: 8 }, (_, index) => ({
            role: index % 2 ? "assistant" : "user",
            content:
              `Study note ${index + 1}. ` +
              "Each query compares its representation with every key, then combines the corresponding values. ".repeat(
                8,
              ),
          })),
        ],
      }),
    },
  });
  expect(response.ok()).toBe(true);
  const { conversation } = await response.json();
  try {
    await page.goto(`/conversations/${conversation.id}`);
    const source = page.getByRole("region", {
      name: "Source transcript",
      exact: true,
    });
    await expect(
      source.getByRole("heading", { name: "User", exact: true }).first(),
    ).toBeVisible();
    await expect(
      source.getByRole("heading", { name: "Assistant", exact: true }).first(),
    ).toBeVisible();
    await expect(source.locator(".katex-display")).toBeVisible();
    await source.getByLabel("Assistant turn 2", { exact: true }).click();
    await expect(source.locator(".katex-display")).toBeHidden();
    await source.getByLabel("Assistant turn 2", { exact: true }).press("Enter");
    await expect(source.locator(".katex-display")).toBeVisible();
    await source.getByLabel("User turn 1", { exact: true }).click();
    await expect(
      source.getByText(/How does attention connect the tokens/),
    ).toBeHidden();
    await source.getByLabel("User turn 1", { exact: true }).click();
    await expect(
      source.getByText(/How does attention connect the tokens/),
    ).toBeVisible();
    await expect(source.locator("table")).toContainText("Queries");
    await expect(source.locator("pre")).toContainText("weights = softmax");
    const sheet = page
      .getByLabel("Scroll transcript")
      .getByText("Understanding attention, one step at a time", { exact: true })
      .locator("..")
      .locator("..");
    const lightBackground = await sheet.evaluate(
      (element) => getComputedStyle(element).backgroundColor,
    );
    const lightInk = await sheet.evaluate(
      (element) => getComputedStyle(element).color,
    );
    await page.screenshot({
      path: testInfo.outputPath("conversation-reader-light.png"),
    });
    const frame = source.locator("iframe");
    await frame.scrollIntoViewIfNeeded();
    await expect(frame).toHaveAttribute("sandbox", "allow-scripts");
    await expect(source.frameLocator("iframe").locator("canvas")).toBeVisible();
    const scroll = page.getByLabel("Scroll transcript");
    await scroll.evaluate((element) => {
      element.scrollTop = 600;
    });
    await expect
      .poll(() =>
        page.evaluate(
          (id) =>
            Number(
              localStorage.getItem(
                `papernook:offline-position:conversation:${id}:source`,
              ),
            ),
          conversation.id,
        ),
      )
      .toBeGreaterThan(500);
    await page.reload();
    await expect
      .poll(() => scroll.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(500);
    await scroll.evaluate((element) => {
      element.scrollTop = 0;
    });
    const question = page.getByRole("textbox", {
      name: "Question",
      exact: true,
    });
    await expect(question).toHaveCSS("border-color", paperInputBorder);
    await expect(
      page.getByRole("button", { name: "Send", exact: true }),
    ).toHaveCSS("background-color", paperSendColor);
    const transcriptToolbar = page
      .getByText("Source transcript", { exact: true })
      .locator("..");
    await expect(transcriptToolbar).toHaveCSS(
      "background-color",
      paperToolbarColor,
    );
    const composer = question.locator("..");
    await expect(composer).toHaveCSS("display", "flex");
    await question.fill("Keep this draft while I read.");
    await page.getByRole("button", { name: "Focus reading" }).click();
    await expect(question).toBeHidden();
    await expect(
      page.getByRole("link", { name: "papernook home" }),
    ).toBeHidden();
    await page.getByRole("button", { name: "Show chat" }).click();
    await expect(question).toHaveValue("Keep this draft while I read.");
    await page.getByRole("button", { name: "Show header" }).click();
    await page
      .getByRole("combobox", { name: "Color theme" })
      .selectOption("dark");
    await expect(page.getByRole("main")).toHaveCSS(
      "background-color",
      "rgb(10, 10, 10)",
    );
    await expect(sheet).not.toHaveCSS("background-color", lightBackground);
    await expect(sheet).not.toHaveCSS("color", lightInk);
    await expect(source.locator(".katex-display")).toHaveCSS(
      "color",
      await sheet.evaluate((element) => getComputedStyle(element).color),
    );
    await page.screenshot({
      path: testInfo.outputPath("conversation-reader-dark.png"),
    });
    await page
      .getByRole("button", { name: "Hide header", exact: true })
      .click();
    await page.screenshot({
      path: testInfo.outputPath("conversation-reader-collapsed-header.png"),
    });
    await page
      .getByRole("button", { name: "Show header", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Account menu for Maya" })
      .press("Enter");
    await page.setViewportSize({ width: 390, height: 844 });
    const mobileAccount = page.getByRole("button", {
      name: "Account menu for Maya",
    });
    await mobileAccount.press("Enter");
    const menuId = await mobileAccount.getAttribute("aria-controls");
    await expect(page.locator(`[id="${menuId}"]`)).toHaveCount(1);
    await expect(page.locator(`[id="${menuId}"]`)).toBeVisible();
    await mobileAccount.press("Escape");
    await page.getByRole("tab", { name: "Chat", exact: true }).click();
    await expect(question).toHaveValue("Keep this draft while I read.");
    const sendBounds = await page
      .getByRole("button", { name: "Send", exact: true })
      .boundingBox();
    expect(sendBounds).not.toBeNull();
    expect(sendBounds!.y + sendBounds!.height).toBeLessThanOrEqual(844);
    await page.getByRole("tab", { name: "Reading", exact: true }).click();
    await expect(question).toBeHidden();
    await expect(
      page.getByRole("link", { name: "papernook home" }),
    ).toBeVisible();
    await expect
      .poll(() =>
        scroll.evaluate(
          (element) => element.scrollHeight > element.clientHeight,
        ),
      )
      .toBe(true);
    await page.screenshot({
      path: testInfo.outputPath("conversation-reader-mobile.png"),
    });
    const scrollBounds = await scroll.boundingBox();
    expect(scrollBounds).not.toBeNull();
    expect(scrollBounds!.y + scrollBounds!.height).toBeLessThanOrEqual(844);
    await page
      .getByRole("combobox", { name: "Color theme" })
      .selectOption("light");
    await expect(sheet).toHaveCSS("background-color", lightBackground);
    await expect(sheet).toHaveCSS("color", lightInk);
  } finally {
    await page.request.delete(`/api/v1/conversations/${conversation.id}`);
  }
});

test("consecutive speaker runs collapse together while preserving individual turn choices", async ({
  page,
}) => {
  await login(page);
  const response = await page.request.post("/api/v1/conversations", {
    data: {
      title: "Long consecutive replies",
      format: "json",
      content: JSON.stringify({
        messages: [
          { role: "user", content: "First question" },
          ...Array.from({ length: 100 }, (_, index) => ({
            role: "assistant",
            content: `Consecutive reply ${index + 1}.`,
          })),
          { role: "user", content: "Next question" },
          { role: "user", content: "Extra context" },
          { role: "assistant", content: "Separate answer" },
        ],
      }),
    },
  });
  expect(response.ok(), await response.text()).toBe(true);
  const { conversation } = await response.json();
  try {
    await page.goto(`/conversations/${conversation.id}`);
    const assistantRun = page.getByLabel("Assistant turns 2 to 101", {
      exact: true,
    });
    await expect(assistantRun).toContainText("100 messages");
    await page.getByLabel("Assistant turn 2", { exact: true }).click();
    await assistantRun.click();
    await expect(
      page.getByText("Consecutive reply 100.", { exact: true }),
    ).toBeHidden();
    await expect(
      page.getByText("Next question", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("Separate answer", { exact: true }),
    ).toBeVisible();
    await assistantRun.press("Enter");
    await expect(
      page.getByText("Consecutive reply 1.", { exact: true }),
    ).toBeHidden();
    await expect(
      page.getByText("Consecutive reply 100.", { exact: true }),
    ).toBeVisible();
    await page.getByLabel("User turns 102 to 103", { exact: true }).click();
    await expect(page.getByText("Next question", { exact: true })).toBeHidden();
    await expect(page.getByText("Extra context", { exact: true })).toBeHidden();
    await expect(
      page.getByText("First question", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("Separate answer", { exact: true }),
    ).toBeVisible();
  } finally {
    await page.request.delete(`/api/v1/conversations/${conversation.id}`);
  }
});

async function login(page: Page) {
  await page.goto("/login");
  await page
    .getByRole("textbox", { name: "Password" })
    .fill("admin-created-password");
  await page.getByRole("button", { name: "Enter", exact: true }).click();
  await page.getByRole("button", { name: "Switch to Maya" }).click();
  await expect(page).toHaveURL("/");
}

for (const width of [1440, 390, 320]) {
  test(`library navigation and home link work at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    await login(page);
    if (width === 390)
      await page
        .getByRole("combobox", { name: "Color theme" })
        .selectOption("dark");
    const nav = page.getByRole("navigation", { name: "Libraries" });
    await expect(
      nav.getByRole("link", { name: "Papers", exact: true }),
    ).toHaveAttribute("aria-current", "page");
    await nav.getByRole("link", { name: "Conversations", exact: true }).click();
    await expect(page).toHaveURL("/conversations");
    await expect(
      nav.getByRole("link", { name: "Conversations", exact: true }),
    ).toHaveAttribute("aria-current", "page");
    await page
      .getByLabel("Public ChatGPT or Claude share link")
      .fill("https://chatgpt.com/share/example");
    await expect(
      page.getByRole("button", { name: "Import conversation", exact: true }),
    ).toBeEnabled();
    await page.screenshot({
      path: testInfo.outputPath("conversation-import.png"),
      fullPage: true,
    });
    const home = page.getByRole("link", { name: "papernook home" });
    await home.locator("img").click();
    await expect(page).toHaveURL("/");
    await nav.getByRole("link", { name: "Conversations", exact: true }).click();
    await home.getByText("papernook", { exact: true }).click();
    await expect(page).toHaveURL("/");
    await page.screenshot({
      path: testInfo.outputPath("library-navigation.png"),
      fullPage: true,
    });
    await nav.getByRole("link", { name: "Downloads", exact: true }).click();
    await expect(page).toHaveURL("/offline/index.html");
  });
}

test("source switching preserves drafts and imports only the selected transcript", async ({
  page,
}) => {
  await login(page);
  await page.goto("/conversations");
  const submit = page.getByRole("button", {
    name: "Import conversation",
    exact: true,
  });
  await expect(submit).toBeDisabled();
  const url = "https://chatgpt.com/share/example";
  await page.getByLabel("Public ChatGPT or Claude share link").fill(url);
  await expect(submit).toBeEnabled();
  await page.getByRole("button", { name: "Paste or upload" }).click();
  await expect(submit).toBeDisabled();
  const transcript =
    "# User\n\nExplain attention.\n\n# Assistant\n\nAttention connects relevant tokens.";
  await page
    .getByRole("textbox", { name: "Transcript", exact: true })
    .fill(transcript);
  await page.getByRole("button", { name: "Share link", exact: true }).click();
  await expect(
    page.getByLabel("Public ChatGPT or Claude share link"),
  ).toHaveValue(url);
  await page.getByRole("button", { name: "Paste or upload" }).click();
  await expect(
    page.getByRole("textbox", { name: "Transcript", exact: true }),
  ).toHaveValue(transcript);
  await page.getByText("Title, topic, and tags", { exact: false }).click();
  await page
    .getByLabel("Title (optional)")
    .fill("Imported from selected source");
  await page.getByLabel("Topic", { exact: true }).first().fill("");
  await submit.click();
  await expect(page).toHaveURL(/\/conversations\/[^/?]+$/);
  const conversationPath = new URL(page.url()).pathname;
  try {
    await expect(
      page.getByRole("heading", { name: "Imported from selected source" }),
    ).toBeVisible();
    await expect(
      page.getByText("Attention connects relevant tokens.", { exact: true }),
    ).toBeVisible();
    await expect(
      page
        .getByRole("navigation", { name: "Libraries" })
        .getByRole("link", { name: "Conversations" }),
    ).toHaveAttribute("aria-current", "page");
  } finally {
    await page.request.delete(`/api/v1${conversationPath}`);
  }
});

test("uploaded transcripts can be corrected and retried after an import error", async ({
  page,
}) => {
  await login(page);
  await page.goto("/conversations");
  await page.getByRole("button", { name: "Paste or upload" }).click();
  await page.getByLabel("Transcript file").setInputFiles({
    name: "conversation.json",
    mimeType: "application/json",
    buffer: Buffer.from("invalid json"),
  });
  await expect(page.getByLabel("Transcript format")).toHaveValue("json");
  const submit = page.getByRole("button", {
    name: "Import conversation",
    exact: true,
  });
  await submit.click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(submit).toBeEnabled();
  await expect(
    page.getByRole("textbox", { name: "Transcript", exact: true }),
  ).toHaveValue("invalid json");
  await page.getByLabel("Transcript file").setInputFiles({
    name: "conversation.md",
    mimeType: "text/markdown",
    buffer: Buffer.from(
      "# User\n\nCan I upload this?\n\n# Assistant\n\nThis transcript was uploaded.",
    ),
  });
  await expect(page.getByLabel("Transcript format")).toHaveValue("markdown");
  await submit.click();
  await expect(page).toHaveURL(/\/conversations\/[^/?]+$/);
  const conversationPath = new URL(page.url()).pathname;
  try {
    await expect(
      page.getByText("This transcript was uploaded.", { exact: true }),
    ).toBeVisible();
  } finally {
    await page.request.delete(`/api/v1${conversationPath}`);
  }
});
