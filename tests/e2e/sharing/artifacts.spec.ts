import { expect, test } from "@playwright/test";
import { restoreMayaSession } from "../support/member-session";
import { canvas } from "../../lib/sharing/artifacts/fixture";

const original = "/api/v1/papers/machine-learning/attention-is-all-you-need";
const remoteOrigin = "https://127.0.0.1:3148";
const apiFor = (href: string) => href.replace("/paper/", "/api/v1/papers/");

test("syncs attributed canvas and exercises, keeps public snapshots read-only, and forks them independently", async ({
  page,
  browser,
}) => {
  test.setTimeout(180_000);
  await page.addInitScript(() => {
    Object.defineProperty(window.crypto, "randomUUID", { value: undefined });
  });
  await restoreMayaSession(page);
  const cleanup: string[] = [];
  let sourceBase = "";
  let initialShare: string | null = null;
  let collaborativeShare: string | null = null;
  try {
    const initial = await page.request.post(`${original}/shares`, {
      data: { mode: "fork", chatIds: [] },
    });
    expect(initial.ok(), await initial.text()).toBe(true);
    const firstShare = (await initial.json()).share;
    initialShare = firstShare.id;
    const sourceImport = await page.request.post("/api/v1/shares/import", {
      data: {
        url: remoteOrigin + firstShare.href,
        mode: "fork",
        topic: "artifact-source",
      },
    });
    expect(sourceImport.ok(), await sourceImport.text()).toBe(true);
    const sourceHref = (await sourceImport.json()).href;
    sourceBase = apiFor(sourceHref);
    cleanup.push(sourceBase);
    await page.request.delete(`${original}/shares/${initialShare}`);
    initialShare = null;
    const firstCanvas = await page.request.put(`${sourceBase}/canvas`, {
      headers: { "X-Canvas-Version": '"empty"' },
      data: { document: canvas("Study snapshot") },
    });
    expect(firstCanvas.ok(), await firstCanvas.text()).toBe(true);
    await page.goto(sourceHref);
    await page.getByText("Exercises", { exact: true }).click();
    await page
      .getByLabel("Add an exercise")
      .fill("# Original exercise\nExplain attention.");
    await page
      .getByRole("button", { name: "Save exercise", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Original exercise" }),
    ).toBeVisible();
    const created = await page.request.post(`${sourceBase}/shares`, {
      data: {
        mode: "collaborate",
        chatIds: [],
        includeArtifacts: true,
        acknowledgePublicAnnotations: true,
      },
    });
    expect(created.ok(), await created.text()).toBe(true);
    const share = (await created.json()).share;
    collaborativeShare = share.id;
    const copy = await page.request.post("/api/v1/shares/import", {
      data: {
        url: remoteOrigin + share.href,
        mode: "collaborate",
        topic: "artifact-members",
        acknowledgePublicAnnotations: true,
      },
    });
    expect(copy.ok(), await copy.text()).toBe(true);
    const { href, participantId } = await copy.json();
    const copyBase = apiFor(href);
    cleanup.push(copyBase);
    expect((await page.request.get(`${copyBase}/canvas`)).status()).toBe(403);
    const approval = await page.request.patch(
      `${sourceBase}/shares/${share.id}/participants`,
      {
        data: {
          id: participantId,
          status: "approved",
          name: "Maya Study Partner",
        },
      },
    );
    expect(approval.ok()).toBe(true);
    await page.goto(`${href}/canvas`);
    const status = page.getByRole("status", { name: "Canvas save status" });
    await expect(status).toHaveText("Saved", { timeout: 60_000 });
    const board = page.locator(".tl-canvas").first();
    const box = (await board.boundingBox())!;
    await page.mouse.click(box.x + 200, box.y + 180);
    await page.keyboard.press("d");
    await page.mouse.move(box.x + 220, box.y + 220);
    await page.mouse.down();
    await page.mouse.move(box.x + 330, box.y + 280, { steps: 5 });
    await page.mouse.up();
    await expect(status).toHaveText("Saved", { timeout: 30_000 });
    await expect
      .poll(async () => {
        const response = await page.request.get(`${sourceBase}/canvas`);
        const data = await response.json();
        return JSON.stringify(data.document).includes(
          '"papernookCreatedByName":"Maya Study Partner"',
        );
      })
      .toBe(true);
    await page.goto(href);
    await page.getByText("Exercises", { exact: true }).click();
    await page
      .getByLabel("Add an exercise")
      .fill("# Collaborator exercise\nCompare attention and recurrence.");
    await page
      .getByRole("button", { name: "Save exercise", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Collaborator exercise" }),
    ).toBeVisible({ timeout: 30_000 });
    const sourceExercises = await (
      await page.request.get(`${sourceBase}/exercises`)
    ).json();
    expect(sourceExercises.records).toContainEqual(
      expect.objectContaining({
        author: "Maya Study Partner",
        markdown: expect.stringContaining("Collaborator exercise"),
      }),
    );
    const anonymous = await browser.newContext();
    try {
      const preview = await anonymous.newPage();
      await preview.goto(share.href);
      await preview
        .getByRole("button", { name: "View canvas and exercises" })
        .click();
      await expect(
        preview.getByLabel("View-only canvas").locator(".tl-canvas"),
      ).toBeVisible({ timeout: 30_000 });
      await expect(
        preview.getByRole("heading", { name: "Original exercise" }),
      ).toBeVisible();
      await expect(
        preview.getByText("Collaborator exercise", { exact: true }),
      ).toHaveCount(0);
      await expect(preview.locator(".tlui-toolbar")).toHaveCount(0);
      await expect(
        preview.getByRole("button", { name: "Comment", exact: true }),
      ).toHaveCount(0);
      await expect(
        preview.getByRole("button", { name: "Save exercise", exact: true }),
      ).toHaveCount(0);
      await expect(preview.locator('[contenteditable="true"]')).toHaveCount(0);
    } finally {
      await anonymous.close();
    }
    const forked = await page.request.post("/api/v1/shares/import", {
      data: {
        url: remoteOrigin + share.href,
        mode: "fork",
        topic: "artifact-independent",
      },
    });
    expect(forked.ok(), await forked.text()).toBe(true);
    const forkBase = apiFor((await forked.json()).href);
    cleanup.push(forkBase);
    const forkCanvas = await page.request.get(`${forkBase}/canvas`);
    expect(JSON.stringify(await forkCanvas.json())).toContain("Study snapshot");
    const forkSave = await page.request.put(`${forkBase}/canvas`, {
      headers: { "X-Canvas-Version": forkCanvas.headers()["x-canvas-version"] },
      data: { document: canvas("Independent revision") },
    });
    expect(forkSave.ok()).toBe(true);
    expect(
      JSON.stringify(
        await (await page.request.get(`${sourceBase}/canvas`)).json(),
      ),
    ).not.toContain("Independent revision");
    const revoke = await page.request.patch(
      `${sourceBase}/shares/${share.id}/participants`,
      { data: { id: participantId, status: "revoked" } },
    );
    expect(revoke.ok()).toBe(true);
    expect((await page.request.get(`${copyBase}/canvas`)).status()).toBe(403);
    expect((await page.request.get(`${copyBase}/exercises`)).status()).toBe(
      403,
    );
    expect((await page.request.get(`${copyBase}/exercises/pdf`)).status()).toBe(
      403,
    );
    expect((await page.request.get(`${forkBase}/canvas`)).ok()).toBe(true);
  } finally {
    if (collaborativeShare)
      await page.request.delete(`${sourceBase}/shares/${collaborativeShare}`);
    if (initialShare)
      await page.request.delete(`${original}/shares/${initialShare}`);
    for (const endpoint of cleanup.reverse())
      await page.request.delete(endpoint);
  }
});
