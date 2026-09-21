import { build } from "esbuild";
import { chromium, expect, test } from "@playwright/test";
import path from "node:path";

test("keeps queued erasure visible, refreshes failures, and clears owner data after authority is lost", async () => {
  test.setTimeout(20_000);
  const component = path.join(
    process.cwd(),
    "src/components/profiles/AdminMembers.tsx",
  );
  const bundle = await build({
    stdin: {
      contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import {AdminMembers} from ${JSON.stringify(component)}; createRoot(document.getElementById('root')).render(React.createElement(AdminMembers,{members:[{username:'reader',displayName:'Reader',isAdmin:false}]}));`,
      resolveDir: process.cwd(),
      loader: "tsx",
    },
    bundle: true,
    write: false,
    outfile: "admin-members.js",
    platform: "browser",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
  });
  const script = bundle.outputFiles.find((file) =>
    file.path.endsWith(".js"),
  )!.text;
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.clock.install();
    let owner = true;
    let pending = false;
    let failed = false;
    let externalVisible = true;
    let releaseDeletion!: () => void;
    const deletionReady = new Promise<void>((resolve) => {
      releaseDeletion = resolve;
    });
    await page.route("http://papernook.test/**", async (route) => {
      const request = route.request();
      if (request.url().endsWith("/api/v1/profiles/reader")) {
        await deletionReady;
        pending = true;
        await route.fulfill({
          status: 202,
          contentType: "application/json",
          body: JSON.stringify({ ok: true, erasure: "pending" }),
        });
        return;
      }
      if (request.url().endsWith("/api/v1/profiles")) {
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            owner,
            profiles: [
              ...(pending
                ? []
                : [
                    {
                      username: "reader",
                      displayName: "Reader",
                      isAdmin: false,
                    },
                  ]),
              ...(externalVisible
                ? [
                    {
                      username: "external",
                      displayName: "External",
                      isAdmin: true,
                    },
                  ]
                : []),
            ],
            ...(owner
              ? {
                  erasures: {
                    workerRunning: true,
                    profiles: pending
                      ? [
                          {
                            username: "reader",
                            status: failed ? "failed" : "pending",
                          },
                        ]
                      : [],
                  },
                }
              : {}),
          }),
        });
        return;
      }
      await route.fulfill({
        contentType: "text/html",
        body: '<div id="root"></div>',
      });
    });
    page.on("dialog", (dialog) => void dialog.accept());
    await page.goto("http://papernook.test/");
    await page.addScriptTag({ content: script });
    await page.getByRole("listitem").filter({ hasText: "External" }).waitFor();
    await page.getByRole("button", { name: "Remove completely" }).click();
    await expect(
      page.getByRole("button", { name: "Remove completely" }),
    ).toBeDisabled();
    releaseDeletion();
    await page.getByRole("heading", { name: "Pending erasure" }).waitFor();
    expect(await page.getByText("Cleanup queued.").isVisible()).toBe(true);
    expect(
      await page.getByRole("button", { name: "Remove completely" }).count(),
    ).toBe(0);
    failed = true;
    externalVisible = false;
    await page.clock.runFor(5000);
    await page
      .getByText("Cleanup needs attention. Automatic retries continue.")
      .waitFor();
    expect(
      await page.getByRole("listitem").filter({ hasText: "External" }).count(),
    ).toBe(0);
    owner = false;
    await page.clock.runFor(5000);
    await page
      .getByText("Owner access is required to manage members.")
      .waitFor();
    expect(
      await page.getByRole("heading", { name: "Pending erasure" }).count(),
    ).toBe(0);
    expect(await page.getByText("reader", { exact: true }).count()).toBe(0);
  } finally {
    await browser.close();
  }
});
