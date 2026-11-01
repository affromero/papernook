import { unzipSync, strFromU8 } from "fflate";
import { parseXml, descendants, children, xmlText, type XmlNode } from "./xml";
import type { DocumentPreview } from "./schema";

export function officePreview(bytes: Uint8Array): DocumentPreview {
  let total = 0;
  let count = 0;
  const files = unzipSync(bytes, {
    filter(file) {
      if (file.compression === 0 && file.size !== file.originalSize)
        throw new Error("Invalid stored document entry size.");
      if (
        ++count > 2000 ||
        file.originalSize > 16 * 1024 * 1024 ||
        (total += file.originalSize) > 32 * 1024 * 1024
      )
        throw new Error("Archive exceeds the expanded preview limit.");
      if (
        file.name.split("/").some((part) => part === "..") ||
        file.name.startsWith("/")
      )
        throw new Error("Invalid document archive path.");
      return /^(word\/document\.xml|xl\/(workbook\.xml|_rels\/workbook\.xml\.rels|sharedStrings\.xml|worksheets\/sheet\d+\.xml)|ppt\/(presentation\.xml|_rels\/presentation\.xml\.rels|slides\/slide\d+\.xml)|(?:word|ppt)\/media\/[^/]+\.(?:png|jpe?g|gif|webp))$/.test(
        file.name,
      );
    },
  });
  if (
    Object.values(files).some((file) => file.length > 16 * 1024 * 1024) ||
    Object.values(files).reduce((size, file) => size + file.length, 0) >
      32 * 1024 * 1024
  )
    throw new Error("Archive exceeds the expanded preview limit.");
  const xml = (name: string) =>
    parseXml(strFromU8(files[name] ?? new Uint8Array()));
  const sections: Extract<DocumentPreview, { kind: "document" }>["sections"] =
    [];
  if (files["word/document.xml"]) {
    const body = descendants(xml("word/document.xml"), "body")[0];
    if (!body) throw new Error("Word document has no body.");
    const blocks: (typeof sections)[number]["blocks"] = children(body).flatMap(
      (node): (typeof sections)[number]["blocks"] => {
        if (node.name === "tbl")
          return [
            {
              kind: "table" as const,
              rows: children(node, "tr").map((row) =>
                children(row, "tc").map(xmlText),
              ),
            },
          ];
        const value = descendants(node, "t").map(xmlText).join("");
        return value ? [{ kind: "text" as const, text: value }] : [];
      },
    );
    sections.push({ title: "Document", blocks });
  } else if (files["xl/workbook.xml"]) {
    const strings = descendants(xml("xl/sharedStrings.xml"), "si").map(xmlText);
    const names = descendants(xml("xl/workbook.xml"), "sheet");
    const relationships = descendants(
      xml("xl/_rels/workbook.xml.rels"),
      "relationship",
    );
    for (const [index, name] of names.entries()) {
      const target = relationships.find(
        (entry) => entry.attributes.Id === name.attributes["r:id"],
      )?.attributes.Target;
      const file = target
        ? target.startsWith("/")
          ? target.slice(1)
          : `xl/${target.replace(/^\.\//, "")}`
        : `xl/worksheets/sheet${index + 1}.xml`;
      if (!/^xl\/worksheets\/sheet\d+\.xml$/.test(file) || !files[file])
        throw new Error("Spreadsheet worksheet is unavailable in this export.");
      const rows = descendants(xml(file), "row").map((row) => {
        const cells: string[] = [];
        for (const cell of children(row, "c")) {
          const letters = /^[A-Z]+/.exec(cell.attributes.r ?? "")?.[0];
          const column = letters
            ? [...letters].reduce(
                (value, letter) => value * 26 + letter.charCodeAt(0) - 64,
                0,
              ) - 1
            : cells.length;
          if (column >= 200)
            throw new Error(
              "Spreadsheet exceeds the 200-column preview limit.",
            );
          while (cells.length < column) cells.push("");
          const raw = descendants(cell, "v")[0];
          const value = raw ? xmlText(raw) : "";
          const formula = descendants(cell, "f")[0];
          cells[column] =
            cell.attributes.t === "s"
              ? (strings[Number(value)] ?? "")
              : cell.attributes.t === "inlineStr"
                ? descendants(cell, "t").map(xmlText).join("")
                : value || (formula ? `=${xmlText(formula)}` : "");
        }
        return cells;
      });
      sections.push({
        title: name.attributes.name || `Sheet ${index + 1}`,
        blocks: [{ kind: "table", rows }],
      });
    }
  } else {
    const relationships = descendants(
      xml("ppt/_rels/presentation.xml.rels"),
      "relationship",
    );
    const slides = descendants(xml("ppt/presentation.xml"), "sldid").map(
      (slide) => {
        const target = relationships.find(
          (entry) => entry.attributes.Id === slide.attributes["r:id"],
        )?.attributes.Target;
        const file = target?.startsWith("/")
          ? target.slice(1)
          : `ppt/${target?.replace(/^\.\//, "")}`;
        if (!/^ppt\/slides\/slide\d+\.xml$/.test(file) || !files[file])
          throw new Error("Presentation slide is unavailable in this export.");
        return file;
      },
    );
    for (const [index, file] of slides.entries()) {
      const slide = xml(file);
      const blocks = descendants(slide, "p")
        .map((node: XmlNode) => ({
          kind: "text" as const,
          text: descendants(node, "t").map(xmlText).join(""),
        }))
        .filter((block) => block.text);
      sections.push({ title: `Slide ${index + 1}`, blocks });
    }
  }
  if (!sections.length)
    throw new Error(
      "This archive is not a supported Word, Excel or PowerPoint document.",
    );
  const images: (typeof sections)[number]["blocks"] = [];
  for (const [name, image] of Object.entries(files)) {
    const extension = /\.(png|jpe?g|gif|webp)$/.exec(name)?.[1];
    if (!extension || image.length > 2 * 1024 * 1024) continue;
    let binary = "";
    for (let offset = 0; offset < image.length; offset += 8192)
      binary += String.fromCharCode(...image.subarray(offset, offset + 8192));
    images.push({
      kind: "image",
      name: name.split("/").at(-1)!,
      source: `data:image/${extension === "jpg" ? "jpeg" : extension};base64,${btoa(binary)}`,
    });
  }
  if (images.length)
    sections.push({ title: "Embedded images", blocks: images });
  return {
    kind: "document",
    sections,
    notice:
      "Read-only content preview. Original layout, charts, macros and external resources may require the downloaded document. Formulas are shown from saved values and are never executed.",
  };
}
