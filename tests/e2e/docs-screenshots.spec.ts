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

    await page.getByRole("link", { name: /Open canvas/ }).click();
    await expect(page.getByRole("button", { name: "Show chat" })).toBeVisible();
    await expect(page).toHaveScreenshot(["product", "canvas.png"], {
      animations: "disabled",
    });
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
    const invite = page
      .getByRole("heading", { name: "Invite a friend" })
      .locator("..");
    await expect(invite).toHaveScreenshot(["setup", "invite-domain.png"], {
      animations: "disabled",
      // The signed expiry and QR payload intentionally change every run.
      maxDiffPixelRatio: 0.08,
    });
    const device = page
      .getByRole("heading", { name: "Connect a device" })
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
    await expect(page.getByText("works now")).toBeVisible({ timeout: 15_000 });
    await expect(page).toHaveScreenshot(["setup", "welcome.png"], {
      animations: "disabled",
      fullPage: true,
    });
    const webdav = page
      .getByRole("heading", { name: "Write on papers" })
      .locator("xpath=ancestor::section[1]");
    await expect(webdav).toHaveScreenshot(["setup", "welcome-webdav.png"], {
      animations: "disabled",
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
    const renderedPage = page
      .getByRole("region", { name: "Paper PDF" })
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
  });
});
