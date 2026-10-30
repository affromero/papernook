import fs from "node:fs";
import { expect, test } from "@playwright/test";
import { restoreMayaSession } from "../support/member-session";

test("imported conversations render images, tables, formulas and isolated diagrams and artifacts", async ({
  page,
}) => {
  await restoreMayaSession(page);
  const image = `data:image/png;base64,${fs.readFileSync("public/logo.png").toString("base64")}`;
  const response = await page.request.post("/api/v1/conversations", {
    data: {
      format: "json",
      content: JSON.stringify({
        messages: [
          {
            role: "assistant",
            content: [
              {
                type: "text",
                text: "<box><text>Rich imported answer</text></box>",
              },
              {
                type: "image",
                image_url: { url: image },
                name: "Imported diagram",
              },
              {
                type: "table",
                columns: ["Artifact", "Purpose"],
                rows: [["Road", "Geometry"]],
              },
              { type: "math", latex: "x^2+y^2=z^2" },
              {
                type: "text",
                text: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 330 80">{#each [0,1,2] as i}<rect x={7+i*109} y="10" width="90" height="50" fill="#248bbd"/>{/each}</svg>',
              },
              { type: "mermaid", content: "graph LR\nRoad --> Scenario" },
              {
                type: "artifact",
                mime_type: "text/html",
                content: `<button id="counter" onclick="this.textContent='Clicked'">Try artifact</button><p id="isolation"></p><p id="network"></p><script>try { parent.document.body; document.querySelector('#isolation').textContent='Parent accessible'; } catch { document.querySelector('#isolation').textContent='Parent isolated'; } fetch('https://example.com/artifact-exfiltration').then(()=>document.querySelector('#network').textContent='Network accessible').catch(()=>document.querySelector('#network').textContent='Network blocked');</script>`,
              },
              {
                type: "image_asset_pointer",
                asset_pointer: "file-service://unavailable",
              },
            ],
          },
        ],
      }),
    },
  });
  expect(response.ok(), await response.text()).toBe(true);
  const { conversation } = await response.json();
  const outsideRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().startsWith("https://example.com/"))
      outsideRequests.push(request.url());
  });
  try {
    await page.goto(`/conversations/${conversation.id}`);
    await expect(
      page.getByText("Rich imported answer", { exact: true }),
    ).toBeVisible();
    const importedImage = page.getByRole("img", {
      name: "Imported diagram",
      exact: true,
    });
    await expect(importedImage).toBeVisible();
    await expect
      .poll(() =>
        importedImage.evaluate(
          (element) => (element as HTMLImageElement).naturalWidth,
        ),
      )
      .toBeGreaterThan(0);
    await expect(page.locator("table")).toContainText("Geometry");
    await expect(page.locator(".katex-display")).toBeVisible();
    const svg = page.frameLocator('iframe[title="SVG diagram"]');
    await page.locator('iframe[title="SVG diagram"]').scrollIntoViewIfNeeded();
    await expect(
      svg.getByRole("img", { name: "Imported SVG diagram" }),
    ).toBeVisible();
    await expect
      .poll(() =>
        svg
          .getByRole("img")
          .evaluate((element) => (element as HTMLImageElement).naturalWidth),
      )
      .toBeGreaterThan(0);
    await page
      .locator('iframe[title="Mermaid diagram"]')
      .scrollIntoViewIfNeeded();
    await expect(
      page.frameLocator('iframe[title="Mermaid diagram"]').locator("svg"),
    ).toBeVisible();
    const frame = page.locator('iframe[title="HTML artifact"]');
    await frame.scrollIntoViewIfNeeded();
    await expect(frame).toHaveAttribute("sandbox", "allow-scripts");
    const artifact = page.frameLocator('iframe[title="HTML artifact"]');
    await expect(
      artifact.getByText("Parent isolated", { exact: true }),
    ).toBeVisible();
    await expect(
      artifact.getByText("Network blocked", { exact: true }),
    ).toBeVisible();
    await artifact.getByRole("button", { name: "Try artifact" }).click();
    await expect(
      artifact.getByRole("button", { name: "Clicked" }),
    ).toBeVisible();
    expect(outsideRequests).toEqual([]);
    await expect(
      page.getByText(/provider did not include this attachment/),
    ).toBeVisible();
    const exported = await page.request.get(
      `/api/v1/conversations/${conversation.id}/export?format=html`,
    );
    const html = await exported.text();
    expect(html).toContain(image);
    expect(html).toContain("data:image/svg+xml;base64,");
    expect(html).toContain("Geometry");
    expect(html).not.toContain("<script");
  } finally {
    await page.request.delete(`/api/v1/conversations/${conversation.id}`);
  }
});
