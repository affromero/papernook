import { expect, test } from "@playwright/test";
import { restoreMayaSession } from "../support/member-session";

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
