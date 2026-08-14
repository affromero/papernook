import { expect, test, type Page } from "@playwright/test";

const password = "admin-created-password";

async function login(page: Page): Promise<void> {
  await page.goto("/login");
  await page.getByRole("textbox", { name: "Password" }).fill(password);
  await page.getByRole("button", { name: "Enter" }).click();
  await page.getByRole("button", { name: "Switch to Maya" }).click();
  await expect(page).toHaveURL("/");
}

test("an early scene failure stays visible and reports no scene text", async ({
  page,
}) => {
  const diagnostics: unknown[] = [];
  await page.route("**/api/v1/client-logs", async (route) => {
    diagnostics.push(route.request().postDataJSON());
    await route.fulfill({ status: 204 });
  });
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
            header: {
              id: "0123456789abcdef",
              title: "Broken visualization",
              createdAt: "2026-08-14T00:00:00.000Z",
            },
            messages: [
              { role: "user", content: "Show a visualization." },
              {
                role: "assistant",
                content:
                  "```threejs\nthrow new Error('SECRET SCENE CONTENT');\n```",
              },
            ],
          },
        }),
      });
    },
  );

  await login(page);
  await page.goto("/paper/machine-learning/attention-is-all-you-need");

  const sandbox = page.frameLocator('iframe[title="Interactive 3D scene"]');
  await expect(sandbox.getByRole("alert")).toContainText(
    "The 3D scene could not start.",
  );
  await expect(
    sandbox.getByRole("button", { name: "Retry 3D scene" }),
  ).toBeVisible();
  await expect.poll(() => diagnostics.length).toBeGreaterThanOrEqual(1);
  expect(JSON.stringify(diagnostics)).not.toContain("SECRET");

  const iframe = page
    .frames()
    .find((frame) => frame.url().includes("/vendor/three-sandbox.html"));
  expect(iframe).toBeDefined();
  await iframe?.evaluate(() => {
    parent.postMessage(
      {
        protocol: 1,
        type: "papernook-three-diagnostic",
        kind: "module-evaluation-failed",
        message: "SECRET FORGED CONTENT",
      },
      "*",
    );
  });
  await page.waitForTimeout(100);
  expect(JSON.stringify(diagnostics)).not.toContain("FORGED");
});
