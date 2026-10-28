import { expect, test } from "@playwright/test";
import { restoreMayaSession } from "../support/member-session";

test("paper navigation and actions remain separate at tablet widths", async ({
  page,
}) => {
  await restoreMayaSession(page);
  await page.goto("/paper/machine-learning/attention-is-all-you-need");
  const views = page.getByRole("navigation", { name: "Paper view" });
  const actions = page.getByRole("navigation", { name: "Paper actions" });
  for (const width of [701, 834]) {
    await page.setViewportSize({ width, height: 1112 });
    await expect(views.getByRole("link", { name: "Original" })).toBeVisible();
    const viewBox = await views.boundingBox();
    const actionBox = await actions.boundingBox();
    expect(viewBox).not.toBeNull();
    expect(actionBox).not.toBeNull();
    expect(viewBox!.x + viewBox!.width).toBeLessThanOrEqual(actionBox!.x);
    expect(actionBox!.x + actionBox!.width).toBeLessThanOrEqual(width);
  }
});

test("switches between a saved paper and its original arXiv page", async ({
  page,
}) => {
  await restoreMayaSession(page);
  await page.route("https://arxiv.org/**", (route) =>
    route.fulfill({ body: "Original paper", contentType: "text/html" }),
  );
  await page.goto("/paper/machine-learning/attention-is-all-you-need");
  await page
    .getByRole("navigation", { name: "Paper view" })
    .getByRole("link", { name: "Original" })
    .click();
  await expect(page).toHaveURL("https://arxiv.org/abs/1706.03762");
  await expect(page.getByText("Original paper")).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(
    "/paper/machine-learning/attention-is-all-you-need",
  );

  // The extension can send an arXiv PDF with a page fragment back to the
  // viewer. It should still resolve the paper already in the library.
  await page.goto(
    `/viewer?src=${encodeURIComponent("https://arxiv.org/pdf/1706.03762#page=3")}`,
  );
  await expect(page).toHaveURL(
    "/paper/machine-learning/attention-is-all-you-need",
  );

  await page.goto(
    `/viewer?src=${encodeURIComponent("https://arxiv.org/pdf/1706.03762?token=example#page=3")}`,
  );
  await expect(page).toHaveURL(
    "/paper/machine-learning/attention-is-all-you-need",
  );
});
