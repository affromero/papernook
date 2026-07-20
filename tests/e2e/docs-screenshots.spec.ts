import { expect, test, type Page } from "@playwright/test";

const password = "admin-created-password";

async function passGate(page: Page): Promise<void> {
  await page.goto("/login");
  await page.getByRole("textbox", { name: "Password" }).fill(password);
  await page.getByRole("button", { name: "Enter" }).click();
  await expect(
    page.getByRole("heading", { name: "Who’s reading?" }),
  ).toBeVisible();
}

async function loginAsAdmin(page: Page): Promise<void> {
  await passGate(page);
  await page.getByRole("button", { name: "Switch to Maya" }).click();
  await expect(page).toHaveURL("/");
  await expect(page.getByText("Attention Is All You Need")).toBeVisible();
}

test.describe.serial("documentation journeys and screenshots", () => {
  test("public gate, profile picker, and library match the documented flow", async ({
    page,
  }) => {
    await page.goto("/login");
    await expect(page.getByText("Maya")).not.toBeVisible();
    await expect(page).toHaveScreenshot(["setup", "access-gate.png"], {
      animations: "disabled",
      maxDiffPixels: 50,
    });

    await page
      .getByRole("textbox", { name: "Password" })
      .fill("wrong-password");
    await page.getByRole("button", { name: "Enter" }).click();
    await expect(
      page.getByText("Wrong password.", { exact: true }),
    ).toBeVisible();
    await page.getByRole("textbox", { name: "Password" }).fill(password);
    await page.getByRole("button", { name: "Enter" }).click();

    const avatar = page
      .getByRole("button", { name: "Switch to Maya" })
      .locator("span")
      .first();
    await expect(avatar).toHaveCSS("border-radius", "50%");
    const avatarImage = page
      .getByRole("button", { name: "Switch to Maya" })
      .locator("img");
    await expect
      .poll(() =>
        avatarImage.evaluate(
          (image) =>
            image instanceof HTMLImageElement &&
            image.complete &&
            image.naturalWidth > 0,
        ),
      )
      .toBe(true);
    await expect(page).toHaveScreenshot(["setup", "profile-picker.png"], {
      animations: "disabled",
    });

    await page.getByRole("button", { name: "Switch to Maya" }).click();
    await expect(page).toHaveURL("/");
    await expect(page).toHaveScreenshot(["product", "library.png"], {
      animations: "disabled",
      fullPage: true,
    });
  });

  test("paper chat can be hidden persistently for a full-width reading view", async ({
    page,
  }) => {
    await loginAsAdmin(page);
    await page.getByText("Attention Is All You Need").click();
    await expect(page.getByText("Page 1 of 3")).toBeVisible();
    const readerUrl = page.url();
    await expect(
      page.getByText("Why was removing recurrence such a big deal?"),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Highlight" })).toBeEnabled();
    await expect(page).toHaveScreenshot(["product", "paper-and-chat.png"], {
      animations: "disabled",
    });

    await page.getByRole("button", { name: "Focus reading" }).click();
    await expect(
      page.getByText("Why attention replaced recurrence"),
    ).not.toBeVisible();
    await expect(page.getByRole("button", { name: "Show chat" })).toBeVisible();
    await expect(page).toHaveScreenshot(["product", "paper-focus.png"], {
      animations: "disabled",
    });
    await page
      .getByRole("button", { name: "Paper fullscreen", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Exit paper fullscreen" }),
    ).toHaveAttribute("aria-pressed", "true");
    const fullscreenReader = page.getByLabel("Attention Is All You Need");
    await expect
      .poll(async () => (await fullscreenReader.boundingBox())?.height ?? 0)
      .toBe(page.viewportSize()!.height);
    await page.keyboard.press("Escape");
    await expect(
      page.getByRole("button", { name: "Paper fullscreen", exact: true }),
    ).toHaveAttribute("aria-pressed", "false");

    await page.goto(`${readerUrl}/canvas`);
    await expect(page).toHaveURL(`${readerUrl}/canvas`);
    await expect(
      page.getByRole("link", { name: "Canvas", exact: true }),
    ).toHaveAttribute("aria-current", "page");
    await expect(
      page.getByText("Paste screenshots, links, or videos"),
    ).toBeVisible();
    const saveStatus = page.getByRole("status", {
      name: "Canvas save status",
    });
    await expect(saveStatus).toHaveText("Saved");
    await expect(page).toHaveScreenshot(["product", "canvas.png"], {
      animations: "disabled",
    });
    const board = page.locator(".tl-canvas").first();
    const boardBox = await board.boundingBox();
    expect(boardBox).not.toBeNull();
    await expect
      .poll(() =>
        page
          .locator("[data-chat-visible]")
          .evaluate(
            (workspace) => workspace.scrollWidth <= workspace.clientWidth,
          ),
      )
      .toBe(true);
    await page.mouse.click(
      boardBox!.x + boardBox!.width / 2,
      boardBox!.y + boardBox!.height / 2,
    );
    await page.keyboard.press("Control+.");
    await expect(
      page.getByRole("button", { name: "Show canvas tools" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Show canvas tools" }).click();
    await expect(
      page.getByRole("button", { name: "Show canvas tools" }),
    ).not.toBeVisible();
    await expect(page.locator(".tlui-toolbar").first()).toBeVisible();
    await page.keyboard.press("d");
    await page.mouse.move(boardBox!.x + 260, boardBox!.y + 220);
    await page.mouse.down();
    await page.mouse.move(boardBox!.x + 360, boardBox!.y + 300, { steps: 4 });
    await page.mouse.up();
    await expect(saveStatus).toHaveText("Unsaved changes");
    await expect(saveStatus).toHaveText("Saved");
    const canvasState = await page.request.get(
      `/api/v1/papers/machine-learning/attention-is-all-you-need/canvas`,
    );
    expect(canvasState.ok()).toBe(true);
    expect(JSON.stringify(await canvasState.json())).toContain(
      '"typeName":"shape"',
    );
    await page.mouse.move(boardBox!.x + 420, boardBox!.y + 240);
    await page.mouse.down();
    await page.mouse.move(boardBox!.x + 500, boardBox!.y + 320, { steps: 4 });
    await page.mouse.up();
    await expect(saveStatus).toHaveText("Unsaved changes");
    await expect(saveStatus).toHaveText("Saved");
    await page.locator(".tl-container").evaluate((container) => {
      const gate = document.createElement("div");
      gate.dataset.testid = "tl-license-expired";
      gate.hidden = true;
      container.append(gate);
    });
    await expect(
      page.getByText("This tldraw key was rejected", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Explain selection" }),
    ).not.toBeVisible();
    await expect(
      page.getByRole("alert").filter({
        hasText: "This tldraw key was rejected",
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Open Canvas settings" }),
    ).toHaveAttribute("href", "/settings#canvas");
    await page.getByRole("link", { name: "Reader", exact: true }).click();
    await expect(page).toHaveURL(readerUrl);
  });

  test("manual theme choice persists across navigation and reload", async ({
    page,
  }) => {
    await loginAsAdmin(page);
    const html = page.locator("html");
    const initial = await html.getAttribute("data-theme");
    expect(initial === "light" || initial === "dark").toBe(true);
    const target = initial === "dark" ? "light" : "dark";
    await page.getByRole("button", { name: `Use ${target} theme` }).click();
    await expect(html).toHaveAttribute("data-theme", target);
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", target);
  });

  test("sharing, graph, invitations, and device setup are visible before sending", async ({
    page,
  }) => {
    await loginAsAdmin(page);
    await page.getByText("Attention Is All You Need").click();
    await page.getByRole("button", { name: "Share", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Create a view-only reading" }),
    ).toBeVisible();
    await expect(page).toHaveScreenshot(["product", "share-reading.png"], {
      animations: "disabled",
    });

    await page.goto("/graph");
    await expect(
      page.getByRole("heading", { name: "How your papers relate" }),
    ).toBeVisible();
    await expect(page).toHaveScreenshot(["product", "relationship-graph.png"], {
      animations: "disabled",
    });

    await page.goto("/settings");
    await page.route("**/api/v1/settings/canvas", async (route) => {
      if (route.request().method() !== "GET") {
        await route.fallback();
        return;
      }
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          configured: true,
          source: "file",
          admin: true,
          requiredForThisOrigin: true,
          licenseKey: "test-key",
        }),
      });
    });
    await page.reload();
    await page.getByRole("button", { name: "Test configured key" }).click();
    const licenseProbe = page.locator(".tl-container").last();
    await licenseProbe.waitFor({ state: "attached" });
    await licenseProbe.evaluate((container) => {
      const gate = document.createElement("div");
      gate.dataset.testid = "tl-license-expired";
      gate.hidden = true;
      container.append(gate);
    });
    await expect(
      page.getByText("Rejected. Replace the key or check its allowed domain.", {
        exact: true,
      }),
    ).toBeVisible();
    await page.unroute("**/api/v1/settings/canvas");
    await page.reload();
    const setupWizard = page.getByRole("link", { name: "Review setup" });
    await expect(setupWizard).toHaveAttribute("href", "/welcome");
    await setupWizard.click();
    await expect(
      page.getByRole("heading", { name: "Welcome, Maya" }),
    ).toBeVisible();
    await page.goto("/settings");
    await expect(page).toHaveURL("/settings");
    const invite = page
      .getByRole("heading", { name: "Invite someone" })
      .locator("..");
    await expect(invite).toHaveScreenshot(["setup", "invite-domain.png"], {
      animations: "disabled",
      // The signed expiry and QR payload intentionally change every run.
      maxDiffPixelRatio: 0.08,
    });
    const device = page
      .getByRole("heading", { name: "Connect a phone or tablet" })
      .locator("..");
    await expect(device).toHaveScreenshot(["setup", "connect-device.png"], {
      animations: "disabled",
    });

    const created = await page.request.post("/api/v1/profiles", {
      data: { displayName: "Casey", avatarSlug: "frog" },
    });
    expect(created.ok()).toBe(true);
    await page.reload();
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "Remove completely" }).click();
    await expect(page.getByText("Casey")).not.toBeVisible();
  });

  test("a friend creates a profile without creating a password", async ({
    page,
  }) => {
    await passGate(page);
    await page.getByRole("button", { name: "Add profile" }).click();
    await page.getByLabel("Name").fill("Jordan");
    await page.getByRole("radio", { name: "Toucan" }).click();
    await page.getByRole("button", { name: "Create" }).click();

    await expect(
      page.getByRole("heading", { name: "Welcome, Jordan" }),
    ).toBeVisible();
    await expect(page.getByText(/Set a password/i)).not.toBeVisible();
    await expect(page.getByText("works now").first()).toBeVisible({
      timeout: 15_000,
    });
    await expect(
      page.getByText(
        "Canvas works on this local address without a key. A key is required after production deployment.",
      ),
    ).toBeVisible();
    await expect(page).toHaveScreenshot(["setup", "welcome.png"], {
      animations: "disabled",
      fullPage: true,
    });
    await page.getByRole("button", { name: "Open my library" }).click();
    await page.goto("/settings");
    await page
      .getByRole("button", { name: "Delete my profile and data" })
      .click();
    await page.getByLabel(/Type jordan to confirm/).fill("jordan");
    await page.getByRole("button", { name: "Delete permanently" }).click();
    await expect(page).toHaveURL("/login");
    await expect(
      page.getByRole("heading", { name: "Enter the access password" }),
    ).toBeVisible();
    await passGate(page);
    await expect(page.getByText("Jordan")).not.toBeVisible();
  });

  test("tablet screenshots preserve the library and paper reading hierarchy", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 834, height: 1112 });
    await loginAsAdmin(page);
    await expect(page).toHaveScreenshot(["product", "library-tablet.png"], {
      animations: "disabled",
      fullPage: true,
    });
    await page.getByText("Attention Is All You Need").click();
    await expect(page.getByText("Page 1 of 3")).toBeVisible();
    await expect(page.getByRole("tab", { name: "Reading" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(
      page.getByText("Why was removing recurrence such a big deal?"),
    ).not.toBeVisible();
    await expect(page.getByRole("button", { name: "Highlight" })).toBeEnabled();
    const renderedPage = page
      .getByRole("tabpanel", { name: "Reading" })
      .locator(".page canvas")
      .first();
    await expect(renderedPage).toBeVisible();
    await expect
      .poll(async () => {
        const box = await renderedPage.boundingBox();
        return box ? Math.min(box.width, box.height) : 0;
      })
      .toBeGreaterThan(100);
    await expect(page).toHaveScreenshot(["product", "paper-tablet.png"], {
      animations: "disabled",
      fullPage: true,
    });

    const pageBox = await renderedPage.boundingBox();
    expect(pageBox).not.toBeNull();
    await renderedPage.dispatchEvent("pointerdown", {
      bubbles: true,
      clientX: pageBox!.x + pageBox!.width / 2,
      clientY: pageBox!.y + pageBox!.height / 2,
      pointerId: 7,
      pointerType: "pen",
    });
    await expect(page.getByRole("button", { name: "Draw" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(
      page.getByText(/touch reserved for pinch zoom/i),
    ).toBeVisible();

    const cdp = await page.context().newCDPSession(page);
    const centerX = pageBox!.x + pageBox!.width / 2;
    const centerY = pageBox!.y + Math.min(pageBox!.height / 2, 320);
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: centerX, y: centerY }],
    });
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: centerX + 24, y: centerY + 16 }],
    });
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    await expect(
      page.getByRole("button", { name: "Save annotations in PDF" }),
    ).toBeDisabled();

    const initialZoom = await page
      .locator("span")
      .filter({ hasText: /^\d+%$/ })
      .textContent();
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [
        { x: centerX - 45, y: centerY },
        { x: centerX + 45, y: centerY },
      ],
    });
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [
        { x: centerX - 75, y: centerY },
        { x: centerX + 75, y: centerY },
      ],
    });
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    await expect
      .poll(() =>
        page
          .locator("span")
          .filter({ hasText: /^\d+%$/ })
          .textContent(),
      )
      .not.toBe(initialZoom);

    await page.getByRole("tab", { name: "Chat" }).click();
    await expect(
      page.getByText("Why was removing recurrence such a big deal?"),
    ).toBeVisible();
    await page.getByRole("tab", { name: "Chat" }).press("ArrowLeft");
    await expect(page.getByRole("tab", { name: "Reading" })).toBeFocused();
  });
});
