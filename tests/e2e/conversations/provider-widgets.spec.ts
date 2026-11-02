import { expect, test } from "@playwright/test";
import { restoreMayaSession } from "../support/member-session";
import { widgetParts } from "../../helpers/conversation-widgets";

const image = `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180" viewBox="0 0 320 180"><rect width="320" height="180" rx="12" fill="#243346"/><path d="M0 150L100 55L205 135L320 30" stroke="#8ec5ff" stroke-width="12" fill="none"/><circle cx="100" cy="55" r="14" fill="#d8edff"/></svg>').toString("base64")}`;

for (const width of [1440, 390]) {
  test(`saved provider widgets and share identities remain readable at ${width}px`, async ({
    page,
    browserName,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    await restoreMayaSession(page);
    const marker = "\uE200image_group\uE202gallery\uE201";
    const response = await page.request.post("/api/v1/conversations", {
      data: {
        title: "Saved provider widgets",
        format: "json",
        content: JSON.stringify({
          messages: [
            { role: "assistant", content: widgetParts },
            {
              role: "assistant",
              content: marker,
              metadata: {
                content_references: [
                  {
                    type: "image_group",
                    matched_text: marker,
                    start_idx: 0,
                    images: [
                      {
                        image_result: {
                          title: "Example chart",
                          url: "https://example.com/chart",
                          content_url: image,
                        },
                      },
                    ],
                  },
                ],
              },
            },
          ],
        }),
      },
    });
    expect(response.ok(), await response.text()).toBe(true);
    const { conversation } = await response.json();
    const created: string[] = [conversation.id];
    try {
      await page.goto(`/conversations/${conversation.id}`);
      const widgets = page.getByRole("region", {
        name: "Saved widget",
        exact: true,
      });
      await expect(widgets).toHaveCount(5);
      await expect(
        widgets.nth(0).getByText("12°C", { exact: true }),
      ).toBeVisible();
      await expect(
        widgets.nth(0).getByRole("cell", { name: "Clear skies", exact: true }),
      ).toBeVisible();
      await expect(
        widgets.nth(1).getByText("$104.25 USD", { exact: true }),
      ).toBeVisible();
      await expect(
        widgets.nth(1).getByText("+$1.25 (+1.21%) · Oct 12, 2026, 16:00 EDT", {
          exact: true,
        }),
      ).toBeVisible();
      await expect(
        widgets
          .nth(2)
          .getByRole("cell", { name: "0 – Not provided", exact: true }),
      ).toBeVisible();
      await expect(
        widgets.nth(3).getByRole("cell", { name: "1. Library", exact: true }),
      ).toBeVisible();
      const plots = widgets.nth(1).locator('iframe[title="SVG diagram"]');
      await plots.scrollIntoViewIfNeeded();
      const diagram = plots
        .contentFrame()
        .getByRole("img", { name: "Imported SVG diagram" });
      await expect(diagram).toBeVisible();
      await expect
        .poll(() =>
          diagram.evaluate((node) =>
            node instanceof HTMLImageElement ? node.naturalWidth : 0,
          ),
        )
        .toBeGreaterThan(0);
      await expect(
        widgets.nth(1).locator('iframe[title="HTML artifact"]'),
      ).toHaveCount(0);
      if (browserName === "chromium" && !testInfo.project.ignoreSnapshots) {
        await page.setViewportSize({ width, height: 2200 });
        await widgets
          .nth(1)
          .evaluate((element) => element.scrollIntoView({ block: "center" }));
        if (width === 1440)
          await expect(widgets.nth(1)).toHaveScreenshot(
            ["conversations", "provider-widgets-desktop.png"],
            { animations: "disabled" },
          );
        else
          await expect(widgets.nth(1)).toHaveScreenshot(
            ["conversations", "provider-widgets-mobile.png"],
            { animations: "disabled" },
          );
        await page.setViewportSize({ width, height: 1000 });
      }
      const gallery = widgets.nth(4);
      await gallery.scrollIntoViewIfNeeded();
      const picture = gallery.getByRole("img", {
        name: "Example chart",
        exact: true,
      });
      await expect(picture).toBeVisible();
      await expect(picture).toHaveJSProperty("naturalWidth", 320);
      await expect(
        gallery.getByRole("link", { name: "Example chart", exact: true }),
      ).toHaveAttribute("href", "https://example.com/chart");
      const exported = await page.request.get(
        `/api/v1/conversations/${conversation.id}/export?format=html`,
      );
      expect(exported.ok()).toBe(true);
      const html = await exported.text();
      expect(html).toContain("104.25 USD");
      expect(html).toContain("0 – Not provided");
      expect(html).toContain("data:image/svg+xml;base64,");
      expect(html).not.toContain("<script");
      expect(html).not.toContain("<iframe");

      const provider = await page.request.post("/api/v1/conversations", {
        data: {
          format: "json",
          content: JSON.stringify({
            title: "Gemini source identity",
            topic: "Research",
            tags: [],
            provider: "transcript",
            sourceUrl: "https://gemini.google.com/share/0123456789ab",
            messages: [
              { role: "assistant", content: "A saved Gemini response." },
            ],
          }),
        },
      });
      expect(provider.ok(), await provider.text()).toBe(true);
      const fresh = (await provider.json()).conversation;
      created.push(fresh.id);
      await page.goto(`/conversations/${fresh.id}`);
      await expect(
        page.getByText("Conversation · gemini", { exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", {
          name: "Refresh shared content",
          exact: true,
        }),
      ).toBeVisible();
      await expect(
        page.getByRole("link", { name: "Original share", exact: true }),
      ).toHaveAttribute("href", "https://gemini.google.com/share/0123456789ab");
    } finally {
      for (const id of created)
        await page.request.delete(`/api/v1/conversations/${id}`);
    }
  });
}
