import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PDFDocument } from "pdf-lib";
import { linearizePdf } from "@/lib/capture/analyze";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "papernook-linearize-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function writePdf(pages: number): Promise<string> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i += 1) doc.addPage([400, 600]);
  const file = path.join(tmpDir, "capture.pdf");
  fs.writeFileSync(file, await doc.save());
  return file;
}

describe("linearizePdf", () => {
  // Whether qpdf is installed or not, the capture must survive intact: the
  // linearized rewrite is an optimisation, never a risk to the download.
  it("leaves a readable PDF with every page it started with", async () => {
    const file = await writePdf(4);
    await linearizePdf(file);

    const reopened = await PDFDocument.load(fs.readFileSync(file));
    expect(reopened.getPageCount()).toBe(4);
  });

  it("leaves a file qpdf cannot process byte-for-byte unchanged", async () => {
    const file = path.join(tmpDir, "capture.pdf");
    fs.writeFileSync(file, "not a pdf at all");
    await linearizePdf(file);

    expect(fs.readFileSync(file, "utf8")).toBe("not a pdf at all");
  });

  it("never leaves its temporary rewrite behind", async () => {
    const file = await writePdf(2);
    await linearizePdf(file);

    expect(fs.readdirSync(tmpDir)).toEqual(["capture.pdf"]);
  });
});
