import { expect, test } from "@playwright/test";
import { restoreMayaSession } from "../support/member-session";

test("the comment editor opens by the selected point and stays visible on resize", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "light" });
  await restoreMayaSession(page);
  await page.goto("/paper/machine-learning/attention-is-all-you-need");
  const pdfPage = page.locator(".pdfViewer .page").first();
  await expect(pdfPage.locator("canvas").first()).toBeVisible();
  const comment = page.getByRole("button", { name: "Comment", exact: true });
  await comment.click();
  await expect(comment).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.getByRole("button", { name: "Select", exact: true }),
  ).toHaveAttribute("aria-pressed", "false");
  await expect(pdfPage).toHaveCSS("cursor", "crosshair");
  await pdfPage.dispatchEvent("pointerdown", {
    pointerType: "pen",
    isPrimary: true,
    bubbles: true,
  });
  await expect(comment).toHaveAttribute("aria-pressed", "true");

  const pageBox = await pdfPage.boundingBox();
  expect(pageBox).not.toBeNull();
  const click = { x: pageBox!.x + 100, y: pageBox!.y + 100 };
  await pdfPage.click({ position: { x: 100, y: 100 } });
  const dialog = page.getByRole("dialog", { name: "Add comment" });
  const textarea = dialog.getByRole("textbox", { name: "Comment" });
  await expect(textarea).toBeFocused();
  const box = await dialog.boundingBox();
  expect(box).not.toBeNull();
  expect(Math.abs(box!.x - click.x)).toBeLessThan(32);
  expect(Math.abs(box!.y - click.y)).toBeLessThan(32);

  const appearance = page.getByRole("combobox", {
    name: "Document appearance",
  });
  await appearance.selectOption("dark");
  await expect(dialog).toHaveCSS("background-color", "rgb(32, 39, 34)");
  await expect(textarea).toHaveCSS("background-color", "rgb(21, 28, 23)");
  await page.emulateMedia({ colorScheme: "dark" });
  await appearance.selectOption("light");
  await expect(dialog).toHaveCSS("background-color", "rgb(247, 248, 244)");
  await expect(textarea).toHaveCSS("background-color", "rgb(255, 255, 255)");

  await textarea.fill("A draft at this location");
  await page.getByRole("button", { name: "Paper fullscreen" }).click();
  await expect(dialog).toBeVisible();
  await expect(textarea).toHaveValue("A draft at this location");
  await page.setViewportSize({ width: 360, height: 600 });
  await expect(comment).toHaveAccessibleName("Comment");
  await expect
    .poll(async () => {
      const bounds = await dialog.boundingBox();
      return (
        bounds !== null &&
        bounds.x >= 0 &&
        bounds.y >= 0 &&
        bounds.x + bounds.width <= 360 &&
        bounds.y + bounds.height <= 600
      );
    })
    .toBe(true);
  await expect(textarea).toHaveValue("A draft at this location");
  page.once("dialog", (confirmation) => void confirmation.dismiss());
  await textarea.press("Escape");
  await expect(textarea).toHaveValue("A draft at this location");
  await expect(
    page.getByRole("button", { name: "Exit paper fullscreen" }),
  ).toBeVisible();

  page.once("dialog", (confirmation) => void confirmation.accept());
  await textarea.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(comment).toBeFocused();
  await expect(
    page.getByRole("button", { name: "Exit paper fullscreen" }),
  ).toBeVisible();
});

test("keyboard users can place a comment on the visible page", async ({
  page,
}, testInfo) => {
  await restoreMayaSession(page);
  await page.goto("/paper/machine-learning/attention-is-all-you-need");
  const pdfPage = page.locator(".pdfViewer .page").first();
  await expect(pdfPage.locator("canvas").first()).toBeVisible();
  const comment = page.getByRole("button", { name: "Comment", exact: true });
  await comment.focus();
  await page.keyboard.press("Enter");
  await expect(comment).toHaveAttribute("aria-pressed", "true");
  // Safari on macOS uses Option-Tab to focus controls when full keyboard
  // access is disabled in the system settings.
  await page.keyboard.press(
    testInfo.project.name === "webkit" && process.platform === "darwin"
      ? "Alt+Tab"
      : "Tab",
  );
  const place = page.getByRole("button", {
    name: "Place comment on visible page",
  });
  await expect(place).toBeFocused();
  await expect(place).toBeVisible();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Add comment" });
  const textarea = dialog.getByRole("textbox", { name: "Comment" });
  await expect(textarea).toBeFocused();
  const pageBounds = await pdfPage.boundingBox();
  const dialogBounds = await dialog.boundingBox();
  expect(pageBounds).not.toBeNull();
  expect(dialogBounds).not.toBeNull();
  const viewport = page.viewportSize()!;
  const anchorX =
    (Math.max(pageBounds!.x, 0) +
      Math.min(pageBounds!.x + pageBounds!.width, viewport.width)) /
    2;
  expect(
    Math.min(
      Math.abs(dialogBounds!.x - anchorX),
      Math.abs(dialogBounds!.x + dialogBounds!.width - anchorX),
    ),
  ).toBeLessThan(32);
  await textarea.fill("Keyboard comment");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
  await expect(comment).toBeFocused();
});

test.describe("touch placement", () => {
  test.use({ hasTouch: true });

  test("a finger can place a comment after Pencil drawing was enabled", async ({
    page,
  }) => {
    await restoreMayaSession(page);
    await page.goto("/paper/machine-learning/attention-is-all-you-need");
    const pdfPage = page.locator(".pdfViewer .page").first();
    await expect(pdfPage.locator("canvas").first()).toBeVisible();
    await pdfPage.dispatchEvent("pointerdown", {
      pointerType: "pen",
      isPrimary: true,
      bubbles: true,
    });
    await expect(
      page.getByRole("button", { name: "Draw", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");

    const comment = page.getByRole("button", { name: "Comment", exact: true });
    await comment.click();
    const originalWidth = (await pdfPage.boundingBox())!.width;
    const pinch = await pdfPage.evaluate((element) => {
      const send = (
        type: string,
        touches: { clientX: number; clientY: number }[],
      ) => {
        const event = new Event(type, { bubbles: true, cancelable: true });
        Object.defineProperty(event, "touches", { value: touches });
        element.dispatchEvent(event);
        return event.defaultPrevented;
      };
      return [
        send("touchstart", [{ clientX: 100, clientY: 100 }]),
        send("touchstart", [
          { clientX: 100, clientY: 100 },
          { clientX: 200, clientY: 100 },
        ]),
        send("touchmove", [
          { clientX: 100, clientY: 100 },
          { clientX: 220, clientY: 100 },
        ]),
        send("touchend", [{ clientX: 100, clientY: 100 }]),
        send("touchend", []),
      ];
    });
    expect(pinch).toEqual([false, true, true, true, true]);
    await expect
      .poll(async () => (await pdfPage.boundingBox())?.width ?? 0)
      .toBeGreaterThan(originalWidth);
    await expect(page.getByRole("dialog", { name: "Add comment" })).toHaveCount(
      0,
    );
    await pdfPage.tap({ position: { x: 100, y: 100 } });
    const dialog = page.getByRole("dialog", { name: "Add comment" });
    await expect(dialog).toBeVisible();
    await expect(comment).toHaveAttribute("aria-pressed", "true");
    await dialog.getByRole("button", { name: "Cancel" }).click();
  });
});
