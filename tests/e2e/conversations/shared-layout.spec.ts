import { expect, test } from "@playwright/test";
import { restoreMayaSession } from "../support/member-session";

const content = `# A driving simulation, from inputs to evaluation

The road and the scenario describe different parts of the same simulation.

## 1. How the pieces fit

<box border radius="xl" padding={3} gap={2}>
  <grid columns={2} gap={2}>
    <grid-item><box background="surface-secondary" radius="lg" padding={3} gap={1}>
      <text color="secondary" weight="medium" size="2xs">STATIC INPUT</text>
      **Road map (\`.xodr\`)**
      <text size="sm">Lanes, intersections and road geometry.</text>
    </box></grid-item>
    <grid-item><box background="surface-secondary" radius="lg" padding={3} gap={1}>
      <text color="secondary" weight="medium" size="2xs">DYNAMIC INPUT</text>
      **Scenario (\`.xosc\`)**
      <text size="sm">Actors, actions and timed behavior.</text>
    </box></grid-item>
  </grid>
  <box align="center" gap={1}>
    <icon name="arrow-down" color="secondary" size="lg"/>
    <box background="rgba(18,120,165,0.07)" radius="lg" width="100%" padding={3} align="center" gap={1}>
      **Scenario execution**
      <text size="sm" textAlign="center">Advance the actors and calculate their states.</text>
    </box>
    <icon name="arrow-down" color="secondary"/>
    <box border radius="lg" width="100%" padding={3} align="center" gap={1}>
      **Rendering and evaluation**
      <text size="sm" textAlign="center">Inspect the generated scene and its behavior.</text>
      <badge color="success">Ready to inspect</badge>
    </box>
  </box>
</box>

## 2. Quantities to measure

Use $x^2+y^2$ to keep equations readable beside the diagram.
`;

test("reading-list icons load automatically, stay compact, and support retry", async ({
  page,
  browserName,
}) => {
  await restoreMayaSession(page);
  const requests: { url: string; referer?: string }[] = [];
  await page.route("**/api/v1/site-icon?**", async (route) => {
    requests.push({
      url: route.request().url(),
      referer: route.request().headers().referer,
    });
    await route.fulfill({
      status: requests.length === 1 ? 404 : 200,
      contentType: requests.length === 1 ? "application/json" : "image/svg+xml",
      body:
        requests.length === 1
          ? JSON.stringify({ error: "Temporary icon failure" })
          : '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><rect width="24" height="24" rx="5" fill="#317c93"/><path d="M6 18V6h8l4 4-4 4H6m7 0 5 4" fill="none" stroke="white" stroke-width="2"/></svg>',
    });
  });
  const response = await page.request.post("/api/v1/conversations", {
    data: {
      title: "Reading list",
      format: "json",
      content: JSON.stringify({
        messages: [
          {
            role: "assistant",
            content: `<box gap={3}>
<text weight="medium">Recommended reading and code</text>
<row align="start" gap={3}>
  <favicon url="https://example.com/private?secret=value" size="24px"/>
  <box flex="1" gap={1}>
    **<Link url="https://example.com/guide" title="Simulation reference"/>**
    <text size="sm" color="secondary">Start with reference lines, lane sections, lane links, junctions, road geometry, traffic signs, intersections, and coordinate systems.</text>
  </box>
</row>
<divider/>
<row align="start" gap={3}>
  <favicon url="https://docs.example.org" size="24px"/>
  <box flex="1" gap={1}>
    **<Link url="https://docs.example.org/manual" title="Scenario manual"/>**
    <text size="sm" color="secondary">Initial conditions, actions, parameters, and timed behavior.</text>
  </box>
</row>
</box>`,
          },
        ],
      }),
    },
  });
  expect(response.ok(), await response.text()).toBe(true);
  const { conversation } = await response.json();
  try {
    await page.goto(`/conversations/${conversation.id}`);
    await page.getByRole("button", { name: "Focus reading" }).click();
    await page
      .getByRole("combobox", { name: "Document appearance" })
      .selectOption("light");
    const list = page
      .getByLabel("Scroll transcript")
      .locator("[data-share-document]");
    const icon = list.getByRole("button", {
      name: "Site icon for example.com",
      exact: true,
    });
    const reference = list.getByRole("link", {
      name: "Simulation reference",
      exact: true,
    });
    const retry = list.getByRole("button", {
      name: "Retry site icon for example.com",
      exact: true,
    });
    await expect(retry).toBeVisible();
    await expect(
      list.getByRole("status", { name: "Site icon could not be loaded" }),
    ).toBeVisible();
    await retry.click();
    await expect(icon).toBeDisabled();
    await expect(icon.locator("img")).toBeVisible();
    await expect(list.locator("pre")).toHaveCount(0);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      const iconBounds = await icon.boundingBox();
      const linkBounds = await reference.boundingBox();
      expect(iconBounds!.width).toBe(24);
      expect(iconBounds!.height).toBe(24);
      expect(linkBounds!.x).toBeGreaterThan(iconBounds!.x + iconBounds!.width);
      expect(Math.abs(linkBounds!.y - iconBounds!.y)).toBeLessThan(5);
      expect(
        await list.evaluate(
          (element) => element.scrollWidth <= element.clientWidth,
        ),
      ).toBe(true);
      if (browserName === "chromium") {
        if (width === 390)
          await expect(list).toHaveScreenshot(
            ["conversations", "reading-list-mobile.png"],
            { animations: "disabled", maxDiffPixelRatio: 0.02 },
          );
        else
          await expect(list).toHaveScreenshot(
            ["conversations", "reading-list-desktop.png"],
            { animations: "disabled", maxDiffPixelRatio: 0.02 },
          );
      }
    }
    await expect
      .poll(
        () =>
          requests.filter(
            (request) =>
              new URL(request.url).searchParams.get("url") ===
              "https://example.com",
          ).length,
      )
      .toBe(2);
    expect(requests.every((request) => !request.referer)).toBe(true);
  } finally {
    await page.request.delete(`/api/v1/conversations/${conversation.id}`);
  }
});

test("XML colors, saved diagrams, and link previews remain readable on desktop and phone", async ({
  page,
  browserName,
}) => {
  await restoreMayaSession(page);
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: async (value: string) => {
          sessionStorage.setItem("copied-link-or-code", value);
        },
      },
    });
  });
  await page.route("**/api/v1/site-icon?**", (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><circle cx="12" cy="12" r="11" fill="#317c93"/></svg>',
    }),
  );
  await page.route("**/api/v1/conversations/*/assets/**", (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="680" height="160" viewBox="0 0 680 160"><rect width="680" height="160" rx="12" fill="#eef4f5"/><g fill="#255368" font-family="sans-serif" font-size="20" text-anchor="middle"><text x="120" y="88">Road geometry</text><text x="340" y="88">Scenario</text><text x="560" y="88">Evaluation</text></g><path d="M210 80h40m180 0h40" stroke="#317c93" stroke-width="3"/></svg>',
    }),
  );
  const xml =
    '<RoadNetwork>\n  <LogicFile filepath="../xodr/highway.xodr"/>\n</RoadNetwork>';
  const href =
    "https://example.com/research/driving/world-models?view=pipeline";
  const response = await page.request.post("/api/v1/conversations", {
    data: {
      title: "Visual references",
      format: "json",
      content: JSON.stringify({
        messages: [
          {
            role: "assistant",
            content: `## Connect the road to the scenario\n\n\`\`\`xml\n${xml}\n\`\`\`\n\n[Driving research](${href}) explains how the road and actor states become a rendered scene.\n\n<box align="end"><Link url="https://edge.example.org/guide" title="Right edge reference"/></box>\n\n<AsyncImage query="A driving pipeline diagram"/>`,
            metadata: {
              genui_components: [
                {
                  type: "async_image",
                  safe_urls: [{ url: "https://example.com/diagram.png" }],
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
  try {
    await page.goto(`/conversations/${conversation.id}`);
    await page.getByRole("button", { name: "Focus reading" }).click();
    await page
      .getByRole("combobox", { name: "Document appearance" })
      .selectOption("dark");
    const scroll = page.getByLabel("Scroll transcript");
    const code = scroll.locator("code.language-xml");
    await expect(code).toHaveText(xml);
    const colors = await Promise.all(
      [".hljs-name", ".hljs-attr", ".hljs-string"].map((selector) =>
        code
          .locator(selector)
          .first()
          .evaluate((element) => getComputedStyle(element).color),
      ),
    );
    expect(new Set(colors).size).toBe(3);
    await scroll
      .getByRole("button", { name: "Copy code", exact: true })
      .click();
    expect(
      await page.evaluate(() => sessionStorage.getItem("copied-link-or-code")),
    ).toBe(xml);
    const image = scroll.getByRole("img", { name: "Conversation image" });
    await expect(image).toBeVisible();
    expect(
      await image.evaluate((element: HTMLImageElement) => element.naturalWidth),
    ).toBe(680);
    await expect(scroll).not.toContainText("Image unavailable");
    const link = scroll.getByRole("link", {
      name: "Driving research",
      exact: true,
    });
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      await link.hover();
      const preview = page.getByRole("dialog", { name: "Link to example.com" });
      await expect(preview).toBeVisible();
      await expect(preview.getByRole("link")).toHaveAttribute("href", href);
      const bounds = await preview.boundingBox();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
      const anchorBounds = await link.boundingBox();
      expect(
        Math.min(
          Math.abs(bounds!.y + bounds!.height - anchorBounds!.y),
          Math.abs(bounds!.y - anchorBounds!.y - anchorBounds!.height),
        ),
      ).toBeLessThan(24);
      await preview.getByRole("button", { name: "Copy link URL" }).click();
      expect(
        await page.evaluate(() =>
          sessionStorage.getItem("copied-link-or-code"),
        ),
      ).toBe(href);
      if (browserName === "chromium") {
        const message = scroll
          .locator("details[data-message-role=assistant]")
          .last();
        if (width === 390)
          await expect(page).toHaveScreenshot(
            ["conversations", "code-link-preview-mobile.png"],
            { animations: "disabled" },
          );
        else
          await expect(message).toHaveScreenshot(
            ["conversations", "code-link-preview-desktop.png"],
            { animations: "disabled" },
          );
      }
      await page.keyboard.press("Escape");
      await expect(preview).toBeHidden();
      await scroll
        .getByRole("link", { name: "Right edge reference", exact: true })
        .hover();
      const edgePreview = page.getByRole("dialog", {
        name: "Link to edge.example.org",
      });
      await expect(edgePreview).toBeVisible();
      const edgeBounds = await edgePreview.boundingBox();
      expect(edgeBounds!.x).toBeGreaterThanOrEqual(0);
      expect(edgeBounds!.x + edgeBounds!.width).toBeLessThanOrEqual(width);
      await page.keyboard.press("Escape");
      await expect(edgePreview).toBeHidden();
      await link.evaluate((element: HTMLAnchorElement) => element.blur());
      await link.focus();
      await expect(preview).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(preview).toBeHidden();
    }
  } finally {
    await page.request.delete(`/api/v1/conversations/${conversation.id}`);
  }
});

test("shared cards retain their visual hierarchy, columns, flow arrows and responsive layout", async ({
  page,
  browserName,
}, testInfo) => {
  await restoreMayaSession(page);
  const response = await page.request.post("/api/v1/conversations", {
    data: {
      title: "A driving simulation",
      format: "json",
      content: JSON.stringify({ messages: [{ role: "assistant", content }] }),
    },
  });
  expect(response.ok(), await response.text()).toBe(true);
  const { conversation } = await response.json();
  try {
    await page.goto(`/conversations/${conversation.id}`);
    await page.getByRole("button", { name: "Focus reading" }).click();
    await page
      .getByRole("combobox", { name: "Document appearance" })
      .selectOption("light");
    const scroll = page.getByLabel("Scroll transcript");
    const diagram = scroll.locator("[data-share-document]");
    await diagram.scrollIntoViewIfNeeded();
    const cards = diagram.locator('[data-share-layout="grid-item"]');
    const first = await cards.nth(0).boundingBox();
    const second = await cards.nth(1).boundingBox();
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(Math.abs(first!.y - second!.y)).toBeLessThan(3);
    expect(second!.x).toBeGreaterThan(first!.x + first!.width);
    const arrows = diagram.locator('[data-share-icon="arrow-down"]');
    await expect(arrows).toHaveCount(2);
    await expect(arrows.first().locator("svg")).toBeVisible();
    await expect(
      diagram.getByText("Ready to inspect", { exact: true }),
    ).toBeVisible();
    const firstCard = cards.first().locator('[data-share-layout="box"]');
    const lightSurface = await firstCard.evaluate(
      (element) => getComputedStyle(element).backgroundColor,
    );
    const title = scroll.getByRole("heading", {
      name: "A driving simulation, from inputs to evaluation",
      exact: true,
    });
    const paragraph = scroll.getByText(
      "The road and the scenario describe different parts of the same simulation.",
      { exact: true },
    );
    const typography = await paragraph.evaluate((element) => ({
      size: parseFloat(getComputedStyle(element).fontSize),
      font: getComputedStyle(element).fontFamily,
    }));
    expect(typography.font).not.toContain("Georgia");
    expect(
      await title.evaluate((element) =>
        parseFloat(getComputedStyle(element).fontSize),
      ),
    ).toBeGreaterThan(typography.size * 1.3);
    await diagram.screenshot({
      path: testInfo.outputPath("shared-layout-light.png"),
    });
    if (browserName === "chromium")
      await expect(diagram).toHaveScreenshot(
        ["conversations", "imported-layout-light.png"],
        { animations: "disabled", maxDiffPixelRatio: 0.02 },
      );
    await page
      .getByRole("combobox", { name: "Document appearance" })
      .selectOption("dark");
    await expect(firstCard).not.toHaveCSS("background-color", lightSurface);
    await diagram.screenshot({
      path: testInfo.outputPath("shared-layout-dark.png"),
    });
    if (browserName === "chromium")
      await expect(diagram).toHaveScreenshot(
        ["conversations", "imported-layout-dark.png"],
        { animations: "disabled", maxDiffPixelRatio: 0.02 },
      );
    await page.setViewportSize({ width: 390, height: 844 });
    await diagram.scrollIntoViewIfNeeded();
    const mobileFirst = await cards.nth(0).boundingBox();
    const mobileSecond = await cards.nth(1).boundingBox();
    expect(mobileSecond!.y).toBeGreaterThan(
      mobileFirst!.y + mobileFirst!.height,
    );
    expect(Math.abs(mobileSecond!.x - mobileFirst!.x)).toBeLessThan(3);
    expect(
      await scroll.evaluate(
        (element) => element.scrollWidth - element.clientWidth,
      ),
    ).toBeLessThan(3);
    await diagram.screenshot({
      path: testInfo.outputPath("shared-layout-mobile.png"),
    });
    if (browserName === "chromium")
      await expect(diagram).toHaveScreenshot(
        ["conversations", "imported-layout-mobile.png"],
        { animations: "disabled", maxDiffPixelRatio: 0.02 },
      );
    const exported = await page.request.get(
      `/api/v1/conversations/${conversation.id}/export?format=html`,
    );
    expect(exported.ok()).toBe(true);
    expect(await exported.text()).toContain('data-share-columns="2"');
  } finally {
    await page.request.delete(`/api/v1/conversations/${conversation.id}`);
  }
});
