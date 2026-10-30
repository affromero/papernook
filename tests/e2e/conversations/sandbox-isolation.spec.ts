import { expect, test } from "@playwright/test";
import { restoreMayaSession } from "../support/member-session";

const source =
  "document.body.dataset.userExecuted = 'yes'; document.body.dataset.exposed = localStorage.getItem('sandbox-private-fixture');";
const previews = [
  {
    name: "HTML artifact",
    url: `/vendor/conversations/sandbox.html#${encodeURIComponent(JSON.stringify({ kind: "html-preview", source: `<script>${source}</script>` }))}`,
  },
  {
    name: "Three.js scene",
    url: `/vendor/three-sandbox.html#${encodeURIComponent(source)}`,
  },
];

for (const preview of previews) {
  test(`${preview.name} rejects direct navigation before executing imported code`, async ({
    page,
  }) => {
    await restoreMayaSession(page);
    await page.evaluate(() =>
      localStorage.setItem(
        "sandbox-private-fixture",
        "private offline fixture",
      ),
    );
    await page.goto(preview.url);
    await expect(
      page.getByText(/Open this (preview|scene) inside the isolated/),
    ).toBeVisible();
    await expect(page.locator("body")).not.toHaveAttribute(
      "data-user-executed",
    );
    await expect(page.locator("body")).not.toHaveAttribute("data-exposed");
  });

  for (const sandbox of [null, "allow-scripts allow-same-origin"]) {
    test(`${preview.name} rejects ${sandbox ? "a frame with same-origin access" : "an unsandboxed frame"}`, async ({
      page,
    }) => {
      await restoreMayaSession(page);
      await page.evaluate(
        ({ url, sandbox }) => {
          localStorage.setItem(
            "sandbox-private-fixture",
            "private offline fixture",
          );
          const frame = document.createElement("iframe");
          frame.id = "preview-isolation-fixture";
          frame.src = url;
          if (sandbox) frame.setAttribute("sandbox", sandbox);
          document.body.append(frame);
        },
        { url: preview.url, sandbox },
      );
      const frame = page.frameLocator("#preview-isolation-fixture");
      await expect(
        frame.getByText(/Open this (preview|scene) inside the isolated/),
      ).toBeVisible();
      await expect(frame.locator("body")).not.toHaveAttribute(
        "data-user-executed",
      );
      await expect(frame.locator("body")).not.toHaveAttribute("data-exposed");
    });
  }
}
