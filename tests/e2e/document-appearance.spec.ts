import { expect, test } from "@playwright/test";

test("documents follow system colors or stay light without changing the PDF", async ({
  page,
}, testInfo) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/login");
  await page
    .getByRole("textbox", { name: "Password" })
    .fill("admin-created-password");
  await page.getByRole("button", { name: "Enter", exact: true }).click();
  await page.getByRole("button", { name: "Switch to Maya" }).click();
  await expect(page).toHaveURL("/");
  await page.goto("/paper/machine-learning/attention-is-all-you-need");
  const pdfUrl =
    "/api/v1/papers/machine-learning/attention-is-all-you-need/pdf";
  const before = await page.request.get(pdfUrl);
  expect(before.ok()).toBe(true);
  const originalBytes = await before.body();
  const pdfPage = page.locator(".pdfViewer .page").first();
  await expect(pdfPage.locator("canvas").first()).toBeVisible();
  const appearance = page.getByRole("combobox", {
    name: "Document appearance",
  });
  await expect(appearance).toHaveValue("theme");
  await expect(pdfPage).not.toHaveCSS("filter", "none");
  await page.screenshot({ path: testInfo.outputPath("paper-dark.png") });
  await appearance.selectOption("light");
  await expect(pdfPage).toHaveCSS("filter", "none");
  await page.reload();
  await expect(appearance).toHaveValue("light");
  await expect(pdfPage).toHaveCSS("filter", "none");
  await appearance.selectOption("theme");
  await page.emulateMedia({ colorScheme: "light" });
  await expect(pdfPage).toHaveCSS("filter", "none");
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(pdfPage).not.toHaveCSS("filter", "none");
  await page.setViewportSize({ width: 320, height: 844 });
  for (const control of [
    appearance,
    ...[
      "Previous page",
      "Next page",
      "Zoom in",
      "Zoom out",
      "Select",
      "Highlight",
      "Text",
      "Draw",
    ].map((name) => page.getByRole("button", { name, exact: true })),
  ]) {
    const bounds = await control.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(320);
  }
  await page.screenshot({ path: testInfo.outputPath("paper-dark-mobile.png") });
  const after = await page.request.get(pdfUrl);
  expect(after.ok()).toBe(true);
  expect(await after.body()).toEqual(originalBytes);
  expect(after.headers().etag).toBe(before.headers().etag);

  const imported = await page.request.post("/api/v1/conversations", {
    data: {
      title: "Document color check",
      format: "markdown",
      content:
        "# User\n\nExplain attention.\n\n# Assistant\n\nAttention preserves $x^2$ and readable text.",
    },
  });
  expect(imported.ok()).toBe(true);
  const { conversation } = await imported.json();
  try {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`/conversations/${conversation.id}`);
    const sheet = page
      .getByLabel("Scroll transcript")
      .getByText("Document color check", { exact: true })
      .locator("../..");
    await expect(sheet).toHaveCSS("background-color", "rgb(23, 23, 23)");
    const other = await page.context().newPage();
    await other.goto("/paper/machine-learning/attention-is-all-you-need");
    await page.goto("/");
    await other
      .getByRole("combobox", { name: "Document appearance" })
      .selectOption("light");
    await page.goto(`/conversations/${conversation.id}`);
    await expect(appearance).toHaveValue("light");
    await expect(sheet).toHaveCSS("background-color", "rgb(255, 255, 255)");
    await other
      .getByRole("combobox", { name: "Document appearance" })
      .selectOption("theme");
    await expect(appearance).toHaveValue("theme");
    await expect(sheet).toHaveCSS("background-color", "rgb(23, 23, 23)");
    await other.close();
    await expect(sheet).toHaveCSS("color", "rgb(237, 237, 237)");
    await expect(sheet.locator(".katex").first()).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath("conversation-dark.png"),
    });
    await appearance.selectOption("light");
    await expect(sheet).toHaveCSS("background-color", "rgb(255, 255, 255)");
    await page.reload();
    await expect(appearance).toHaveValue("light");
    await expect(sheet).toHaveCSS("background-color", "rgb(255, 255, 255)");
    await appearance.selectOption("theme");
    await page.emulateMedia({ colorScheme: "light" });
    await expect(sheet).toHaveCSS("background-color", "rgb(255, 255, 255)");
    await page.emulateMedia({ colorScheme: "dark" });
    await expect(sheet).toHaveCSS("background-color", "rgb(23, 23, 23)");
  } finally {
    await page.request.delete(`/api/v1/conversations/${conversation.id}`);
  }
});
