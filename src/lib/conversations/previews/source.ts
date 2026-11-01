import crypto from "node:crypto";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import type { Root, RootContent } from "mdast";
import { normalizeMath } from "@/lib/chat/normalize-math";
import { normalizeProviderText } from "@/lib/chat/normalize-provider-text";
import type { ShareMarkupContext } from "@/lib/chat/normalize-share-markup";
import { isPreviewKind } from "../preview";
import { previewIdentity } from "./identity";

export function previewHash(kind: string, source: string): string {
  return crypto
    .createHash("sha256")
    .update(previewIdentity(kind, source))
    .digest("hex");
}
export function messagePreviews(
  content: string,
  context: ShareMarkupContext,
): Array<{ kind: string; hash: string }> {
  const root = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .parse(normalizeMath(normalizeProviderText(content, context)));
  const result: Array<{ kind: string; hash: string }> = [];
  function visit(node: Root | RootContent): void {
    if (
      node.type === "code" &&
      node.lang &&
      (isPreviewKind(node.lang) || node.lang === "threejs")
    )
      result.push({
        kind: node.lang,
        hash: previewHash(node.lang, node.value),
      });
    if ("children" in node) for (const child of node.children) visit(child);
  }
  visit(root);
  return result;
}
