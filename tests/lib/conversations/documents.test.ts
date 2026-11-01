import { describe, expect, it } from "vitest";
import { zipSync, strToU8 } from "fflate";
import { documentPreview } from "@/lib/conversations/documents/parse";

const archive = (files: Record<string, string>) =>
  zipSync(
    Object.fromEntries(
      Object.entries(files).map(([name, source]) => [name, strToU8(source)]),
    ),
  );

describe("read-only attachment previews", () => {
  it("parses quoted CSV and TSV cells without executing spreadsheet formulas", () => {
    const csv = documentPreview(
      strToU8(
        'Name,Value\n"Road, scene","line one\nline two"\nFormula,"=WEBSERVICE(""https://example.com"")"',
      ),
      "measurements.csv",
      "text/csv",
    );
    expect(csv).toMatchObject({
      kind: "document",
      sections: [
        {
          blocks: [
            {
              kind: "table",
              rows: [
                ["Name", "Value"],
                ["Road, scene", "line one\nline two"],
                ["Formula", '=WEBSERVICE("https://example.com")'],
              ],
            },
          ],
        },
      ],
    });
    expect(
      documentPreview(
        strToU8("Name\tValue\nRoad\t42"),
        "scores.tsv",
        "text/tab-separated-values",
      ),
    ).toMatchObject({
      sections: [
        {
          blocks: [
            {
              rows: [
                ["Name", "Value"],
                ["Road", "42"],
              ],
            },
          ],
        },
      ],
    });
  });
  it("previews Word paragraphs and tables as plain text", () => {
    const bytes = archive({
      "word/document.xml":
        '<w:document xmlns:w="urn:w"><w:body><w:p><w:r><w:t>Document &amp; data</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Cell 42</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>',
    });
    expect(
      documentPreview(bytes, "report.docx", "application/octet-stream"),
    ).toMatchObject({
      sections: [
        {
          blocks: [
            { kind: "text", text: "Document & data" },
            { kind: "table", rows: [["Cell 42"]] },
          ],
        },
      ],
    });
  });
  it("uses spreadsheet relationships, shared strings and saved formula results", () => {
    const bytes = archive({
      "xl/workbook.xml":
        '<workbook><sheets><sheet name="Results" r:id="rId9"/></sheets></workbook>',
      "xl/_rels/workbook.xml.rels":
        '<Relationships><Relationship Id="rId9" Target="worksheets/sheet2.xml"/></Relationships>',
      "xl/sharedStrings.xml": "<sst><si><t>Road score</t></si></sst>",
      "xl/worksheets/sheet2.xml":
        '<worksheet><sheetData><row><c r="A1" t="s"><v>0</v></c><c r="C1"><f>20+22</f><v>42</v></c></row></sheetData></worksheet>',
    });
    expect(
      documentPreview(bytes, "results.xlsx", "application/octet-stream"),
    ).toMatchObject({
      sections: [
        { title: "Results", blocks: [{ rows: [["Road score", "", "42"]] }] },
      ],
    });
  });
  it("preserves presentation slide order from its relationship list", () => {
    const bytes = archive({
      "ppt/presentation.xml":
        '<p:presentation><p:sldIdLst><p:sldId r:id="last"/><p:sldId r:id="first"/></p:sldIdLst></p:presentation>',
      "ppt/_rels/presentation.xml.rels":
        '<Relationships><Relationship Id="last" Target="slides/slide9.xml"/><Relationship Id="first" Target="slides/slide1.xml"/></Relationships>',
      "ppt/slides/slide9.xml":
        "<p:sld><a:p><a:r><a:t>Opening slide</a:t></a:r></a:p></p:sld>",
      "ppt/slides/slide1.xml":
        "<p:sld><a:p><a:r><a:t>Closing slide</a:t></a:r></a:p></p:sld>",
    });
    expect(
      documentPreview(bytes, "deck.pptx", "application/octet-stream"),
    ).toMatchObject({
      sections: [
        { title: "Slide 1", blocks: [{ text: "Opening slide" }] },
        { title: "Slide 2", blocks: [{ text: "Closing slide" }] },
      ],
    });
  });
  it("retains notebook displays and treats attached HTML as an isolated artifact", () => {
    const notebook = strToU8(
      JSON.stringify({
        nbformat: 4,
        cells: [
          {
            cell_type: "code",
            source: ["x=1\n", "print(x)"],
            outputs: [
              {
                output_type: "display_data",
                data: { "text/html": "<p>Notebook result</p>" },
              },
            ],
          },
        ],
      }),
    );
    expect(
      documentPreview(notebook, "session.ipynb", "application/json"),
    ).toMatchObject({
      kind: "notebook",
      content: expect.stringContaining("notebook-preview"),
    });
    expect(
      documentPreview(
        strToU8("<script>window.example=1</script>"),
        "report.html",
        "text/html",
      ),
    ).toEqual({
      kind: "artifact",
      format: "html-preview",
      content: "<script>window.example=1</script>",
    });
  });
  it("rejects archive expansion, traversal, entities and oversized tables", () => {
    const stored = zipSync(
      {
        "word/document.xml": strToU8(
          "<document><body>Saved text</body></document>",
        ),
      },
      { level: 0 },
    );
    const forged = Buffer.from(stored);
    for (let index = 0; index < forged.length - 24; index++)
      if (forged.readUInt32LE(index) === 0x02014b50) {
        forged.writeUInt32LE(0, index + 24);
        break;
      }
    expect(() => documentPreview(forged, "forged.docx", "")).toThrow(
      /stored document entry/,
    );
    expect(() =>
      documentPreview(
        archive({ "word/document.xml": "x".repeat(16 * 1024 * 1024 + 1) }),
        "report.docx",
        "",
      ),
    ).toThrow(/expanded preview limit/);
    expect(() =>
      documentPreview(
        archive({ "../word/document.xml": "x" }),
        "report.docx",
        "",
      ),
    ).toThrow(/archive path/);
    expect(() =>
      documentPreview(
        archive({
          "word/document.xml":
            '<!DOCTYPE document [<!ENTITY attack SYSTEM "https://example.com/private">]><document><body>&attack;</body></document>',
        }),
        "report.docx",
        "",
      ),
    ).toThrow(/declarations/);
    expect(() =>
      documentPreview(strToU8("a,b\n".repeat(2001)), "rows.csv", "text/csv"),
    ).toThrow();
  });
});
