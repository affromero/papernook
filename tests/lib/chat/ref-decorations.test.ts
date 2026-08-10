import { describe, expect, it } from "vitest";
import { rehypePaperRefs, type HastNode } from "@/lib/chat/ref-decorations";
import type { Bibliography } from "@/lib/pdf/bibliography";

function paragraph(text: string): HastNode {
  return {
    type: "root",
    children: [
      {
        type: "element",
        tagName: "p",
        properties: {},
        children: [{ type: "text", value: text }],
      },
    ],
  };
}

function buttons(tree: HastNode): HastNode[] {
  const found: HastNode[] = [];
  const visit = (node: HastNode) => {
    if (node.tagName === "button") found.push(node);
    node.children?.forEach(visit);
  };
  visit(tree);
  return found;
}

function textOf(node: HastNode): string {
  if (node.type === "text") return node.value ?? "";
  return (node.children ?? []).map(textOf).join("");
}

const numberedBibliography: Bibliography = {
  style: "numbered",
  entries: [
    {
      pageNumber: 9,
      x: 40,
      y: 700,
      text: "[20] Kheradmand et al. 3D Gaussian Splatting as MCMC. 2024.",
      surname: "Kheradmand",
      year: "2024",
      suffix: null,
      number: 20,
    },
  ],
};

describe("rehypePaperRefs", () => {
  it("wraps paper refs in buttons and keeps surrounding text intact", () => {
    const tree = paragraph("See Figure 3 and Sec. 4.3 for details.");
    rehypePaperRefs()(tree);
    const [figure, section] = buttons(tree);
    expect(textOf(figure!)).toBe("Figure 3");
    expect(figure!.properties?.dataPaperRef).toBe(
      JSON.stringify({ kind: "figure", label: "3" }),
    );
    expect(textOf(section!)).toBe("Sec. 4.3");
    expect(textOf(tree)).toBe("See Figure 3 and Sec. 4.3 for details.");
  });

  it("decorates citations only when they resolve in the bibliography", () => {
    const tree = paragraph("as shown in [20] but not [7]");
    rehypePaperRefs({ bibliography: numberedBibliography })(tree);
    const all = buttons(tree);
    expect(all).toHaveLength(1);
    expect(all[0]!.properties?.dataCitation).toBe(
      JSON.stringify({ kind: "numeric", number: 20 }),
    );
    expect(all[0]!.properties?.ariaLabel).toContain("Kheradmand");
  });

  it("leaves citations untouched without a bibliography", () => {
    const tree = paragraph("as shown in [20]");
    rehypePaperRefs()(tree);
    expect(buttons(tree)).toHaveLength(0);
  });

  it("never rewrites code or katex subtrees", () => {
    const tree: HastNode = {
      type: "root",
      children: [
        {
          type: "element",
          tagName: "code",
          properties: {},
          children: [{ type: "text", value: "plot(Figure 3)" }],
        },
        {
          type: "element",
          tagName: "span",
          properties: { className: ["katex"] },
          children: [{ type: "text", value: "Figure 3" }],
        },
      ],
    };
    rehypePaperRefs()(tree);
    expect(buttons(tree)).toHaveLength(0);
  });

  it("keeps ref and citation decorations ordered and non-overlapping", () => {
    const tree = paragraph("Figure 3 relates to [20].");
    rehypePaperRefs({ bibliography: numberedBibliography })(tree);
    const all = buttons(tree);
    expect(all.map((node) => textOf(node))).toEqual(["Figure 3", "20"]);
    expect(textOf(tree)).toBe("Figure 3 relates to [20].");
  });
});
