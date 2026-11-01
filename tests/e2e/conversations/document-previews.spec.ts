import fs from "node:fs";
import { zipSync, strToU8 } from "fflate";
import { expect, test } from "@playwright/test";
import { restoreMayaSession } from "../support/member-session";

const office = (files: Record<string, string>) =>
  Buffer.from(
    zipSync(
      Object.fromEntries(
        Object.entries(files).map(([name, text]) => [name, strToU8(text)]),
      ),
    ),
  );
const files = [
  {
    name: "scores.csv",
    mime: "text/csv",
    bytes: Buffer.from('Metric,Value\n"Road, scene",42'),
    text: "Road, scene",
  },
  {
    name: "report.docx",
    mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    bytes: office({
      "word/document.xml":
        "<w:document><w:body><w:p><w:r><w:t>Saved Word paragraph</w:t></w:r></w:p></w:body></w:document>",
    }),
    text: "Saved Word paragraph",
  },
  {
    name: "results.xlsx",
    mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    bytes: office({
      "xl/workbook.xml":
        '<workbook><sheets><sheet name="Scores" r:id="rId1"/></sheets></workbook>',
      "xl/_rels/workbook.xml.rels":
        '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
      "xl/worksheets/sheet1.xml":
        '<worksheet><sheetData><row><c r="A1" t="inlineStr"><is><t>Saved spreadsheet value</t></is></c><c r="B1"><v>42</v></c></row></sheetData></worksheet>',
    }),
    text: "Saved spreadsheet value",
  },
  {
    name: "slides.pptx",
    mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    bytes: office({
      "ppt/presentation.xml":
        '<p:presentation><p:sldIdLst><p:sldId r:id="slide"/></p:sldIdLst></p:presentation>',
      "ppt/_rels/presentation.xml.rels":
        '<Relationships><Relationship Id="slide" Target="slides/slide1.xml"/></Relationships>',
      "ppt/slides/slide1.xml":
        "<p:sld><a:p><a:r><a:t>Saved slide text</a:t></a:r></a:p></p:sld>",
    }),
    text: "Saved slide text",
  },
  {
    name: "session.ipynb",
    mime: "application/json",
    bytes: Buffer.from(
      JSON.stringify({
        nbformat: 4,
        cells: [
          { cell_type: "markdown", source: ["Saved notebook heading"] },
          {
            cell_type: "code",
            source: ["print(42)"],
            outputs: [
              {
                output_type: "display_data",
                data: {
                  "text/html":
                    "<table><tr><td>Notebook value 42</td></tr></table>",
                },
              },
            ],
          },
        ],
      }),
    ),
    text: "Saved notebook heading",
  },
];

for (const width of [1440, 390])
  test(`attached documents open readable previews at ${width}px`, async ({
    page,
    browserName,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    await restoreMayaSession(page);
    const pdf = fs.readFileSync(
      ".playwright-data/papers/machine-learning/attention-is-all-you-need.pdf",
    );
    const response = await page.request.post("/api/v1/conversations", {
      data: {
        format: "json",
        content: JSON.stringify({
          messages: [
            {
              role: "assistant",
              content: [
                ...files.map((file) => ({
                  type: "file",
                  name: file.name,
                  mime_type: file.mime,
                  data: file.bytes.toString("base64"),
                })),
                {
                  type: "file",
                  name: "paper.pdf",
                  mime_type: "application/pdf",
                  data: pdf.toString("base64"),
                },
              ],
            },
          ],
        }),
      },
    });
    expect(response.ok(), await response.text()).toBe(true);
    const { conversation } = await response.json();
    try {
      await page.goto(`/conversations/${conversation.id}`);
      for (const file of files) {
        await page
          .getByText(file.name, { exact: true })
          .locator("..")
          .getByRole("button", { name: "Preview document" })
          .click();
        const dialog = page.getByRole("dialog", {
          name: `Preview ${file.name}`,
        });
        await expect(
          dialog.getByText(file.text, { exact: true }),
        ).toBeVisible();
        if (
          file.name === "scores.csv" &&
          browserName === "chromium" &&
          !testInfo.project.ignoreSnapshots
        ) {
          if (width === 1440)
            await expect(dialog).toHaveScreenshot(
              ["conversations", "document-preview-desktop.png"],
              { animations: "disabled" },
            );
          else
            await expect(dialog).toHaveScreenshot(
              ["conversations", "document-preview-mobile.png"],
              { animations: "disabled" },
            );
        }
        if (file.name.endsWith("ipynb"))
          await expect(
            dialog
              .locator('iframe[title="Notebook output"]')
              .contentFrame()
              .getByText("Notebook value 42"),
          ).toBeVisible();
        await dialog.getByRole("button", { name: "Close preview" }).click();
        await expect(dialog).toHaveCount(0);
      }
      await page
        .getByText("paper.pdf", { exact: true })
        .locator("..")
        .getByRole("button", { name: "Preview document" })
        .click();
      const dialog = page.getByRole("dialog", { name: "Preview paper.pdf" });
      await expect(dialog.locator("canvas").first()).toBeVisible({
        timeout: 15000,
      });
      await expect(dialog).toContainText("Attention Is All You Need");
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
    } finally {
      await page.request.delete(`/api/v1/conversations/${conversation.id}`);
    }
  });
