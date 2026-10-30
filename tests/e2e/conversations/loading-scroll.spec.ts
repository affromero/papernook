import { expect, test } from "@playwright/test";
import { restoreMayaSession } from "../support/member-session";

test("reading earlier follow-up text stays in place while a reply streams and finishes", async ({
  page,
}) => {
  await restoreMayaSession(page);
  const response = await page.request.post("/api/v1/conversations", {
    data: { content: "Source transcript", format: "markdown" },
  });
  expect(response.ok()).toBe(true);
  const { conversation } = await response.json();
  await page.addInitScript(() => {
    const original = window.fetch;
    window.fetch = async (input, init) => {
      if (String(input).endsWith("/chats") && init?.method === "POST") {
        return new Response(
          new ReadableStream({
            start(controller) {
              const encoder = new TextEncoder();
              const listener = (event: Event) => {
                const payload = (
                  event as CustomEvent<{ text: string; close?: boolean }>
                ).detail;
                controller.enqueue(encoder.encode(payload.text + "\n"));
                if (payload.close) {
                  window.removeEventListener(
                    "conversation-test-stream",
                    listener,
                  );
                  controller.close();
                }
              };
              window.addEventListener("conversation-test-stream", listener);
              controller.enqueue(
                encoder.encode(
                  JSON.stringify({
                    type: "delta",
                    text:
                      "Stream introduction. " +
                      "A detailed explanation of the map and its geometry. ".repeat(
                        250,
                      ),
                  }) + "\n",
                ),
              );
            },
          }),
          { headers: { "Content-Type": "application/x-ndjson" } },
        );
      }
      return original(input, init);
    };
  });
  try {
    await page.goto(`/conversations/${conversation.id}`);
    await page
      .getByRole("textbox", { name: "Question", exact: true })
      .fill("Explain it");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    const scroll = page.getByLabel("Scroll follow-up chat");
    await expect
      .poll(() => scroll.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(500);
    await scroll.evaluate((element) => {
      element.scrollTop = 0;
    });
    await expect
      .poll(() => scroll.evaluate((element) => element.scrollTop))
      .toBeLessThan(10);
    await page.evaluate(() =>
      window.dispatchEvent(
        new CustomEvent("conversation-test-stream", {
          detail: {
            text: JSON.stringify({
              type: "delta",
              text: "\n\nThe next streamed explanation.",
            }),
          },
        }),
      ),
    );
    await expect(scroll.getByText(/next streamed explanation/)).toBeAttached();
    await expect
      .poll(() => scroll.evaluate((element) => element.scrollTop))
      .toBeLessThan(10);
    await page.evaluate(() =>
      window.dispatchEvent(
        new CustomEvent("conversation-test-stream", {
          detail: {
            close: true,
            text: JSON.stringify({
              type: "done",
              chat: {
                header: {
                  id: "1234567890abcdef",
                  username: "maya",
                  title: "Explain it",
                  createdAt: new Date().toISOString(),
                },
                messages: [
                  { role: "user", content: "Explain it" },
                  {
                    role: "assistant",
                    content:
                      "Stream introduction. " +
                      "A detailed explanation of the map and its geometry. ".repeat(
                        250,
                      ) +
                      "\n\nThe next streamed explanation.",
                  },
                ],
              },
            }),
          },
        }),
      ),
    );
    await expect(
      page.getByRole("textbox", { name: "Question", exact: true }),
    ).toBeEnabled();
    await expect
      .poll(() => scroll.evaluate((element) => element.scrollTop))
      .toBeLessThan(100);
  } finally {
    await page.request.delete(`/api/v1/conversations/${conversation.id}`);
  }
});

test("scrolling a long transcript preserves collapsed lists and lets the reader move upward", async ({
  page,
}) => {
  await restoreMayaSession(page);
  const response = await page.request.post("/api/v1/conversations", {
    data: {
      format: "json",
      content: JSON.stringify({
        messages: [
          {
            role: "assistant",
            content: Array.from(
              { length: 40 },
              (_, index) =>
                `## Topic ${index + 1}\n\n1. First explanation.\n2. Second explanation.\n\n${"Details about the road and its geometry. ".repeat(20)}`,
            ).join("\n\n"),
          },
        ],
      }),
    },
  });
  expect(response.ok(), await response.text()).toBe(true);
  const { conversation } = await response.json();
  try {
    await page.goto(`/conversations/${conversation.id}`);
    const scroll = page.getByLabel("Scroll transcript");
    const list = scroll.locator("details:has(> ol)").first();
    await list.locator(":scope > summary").click();
    await expect(list).not.toHaveAttribute("open");
    await scroll.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await expect
      .poll(() => scroll.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(1000);
    await expect(list).not.toHaveAttribute("open");
    await scroll.hover();
    await page.mouse.wheel(0, -1200);
    await expect
      .poll(() =>
        scroll.evaluate(
          (element) =>
            element.scrollHeight - element.clientHeight - element.scrollTop,
        ),
      )
      .toBeGreaterThan(500);
    await scroll.evaluate((element) => {
      element.scrollTop = 0;
    });
    await expect
      .poll(() => scroll.evaluate((element) => element.scrollTop))
      .toBeLessThan(10);
    await expect(list).not.toHaveAttribute("open");
  } finally {
    await page.request.delete(`/api/v1/conversations/${conversation.id}`);
  }
});

test("import progress stays visible until the conversation opens", async ({
  page,
}) => {
  await restoreMayaSession(page);
  await page.goto("/conversations");
  await page.getByRole("button", { name: "Paste or upload" }).click();
  await page
    .getByRole("textbox", { name: "Transcript", exact: true })
    .fill("A saved conversation.");
  let releaseImport: () => void = () => {};
  const importGate = new Promise<void>((resolve) => {
    releaseImport = resolve;
  });
  let releaseNavigation: () => void = () => {};
  const navigationGate = new Promise<void>((resolve) => {
    releaseNavigation = resolve;
  });
  let id = "";
  await page.route("**/api/v1/conversations", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    await importGate;
    const response = await route.fetch();
    id = (await response.json()).conversation.id;
    await route.fulfill({ response });
  });
  await page.route(/\/conversations\/[^/?]+\?_rsc=/, async (route) => {
    await navigationGate;
    await route.continue();
  });
  try {
    await page
      .getByRole("button", { name: "Import conversation", exact: true })
      .click();
    await expect(page.getByRole("status")).toContainText("Importing");
    await expect(page.getByRole("progressbar")).toBeVisible();
    releaseImport();
    await expect.poll(() => id).not.toBe("");
    await expect(page.getByRole("status")).toContainText("Opening");
    await expect(page.getByRole("button", { name: /Opening/ })).toBeDisabled();
    releaseNavigation();
    await expect(page).toHaveURL(`/conversations/${id}`);
    await expect(
      page.getByText("A saved conversation.", { exact: true }),
    ).toBeVisible();
  } finally {
    releaseImport();
    releaseNavigation();
    await page.unrouteAll({ behavior: "wait" });
    if (id) await page.request.delete(`/api/v1/conversations/${id}`);
  }
});
