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
