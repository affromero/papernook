import {
  array,
  requiredText,
  sourceTitle,
  validateTranscript,
  type ShareMessage,
  type ShareTranscript,
} from "./schema";

function slot(value: unknown, ...indices: number[]): unknown {
  for (const index of indices)
    value = Array.isArray(value) ? value[index] : undefined;
  return value;
}

export function geminiTranscript(
  body: string,
  shareId: string,
): ShareTranscript {
  let payload: unknown;
  for (const line of body.split("\n")) {
    if (!line.startsWith("[[")) continue;
    let rows: unknown;
    try {
      rows = JSON.parse(line);
    } catch {
      continue;
    }
    for (const row of array(rows)) {
      if (slot(row, 0) !== "wrb.fr" || slot(row, 1) !== "ujx1Bf") continue;
      const encoded = slot(row, 2);
      if (typeof encoded !== "string")
        throw new Error("Gemini did not expose this public conversation.");
      payload = JSON.parse(encoded) as unknown;
    }
  }
  const root = slot(payload, 0);
  if (!Array.isArray(root) || root[3] !== shareId || !Array.isArray(root[1]))
    throw new Error(
      "Gemini returned an unreadable or mismatched public conversation.",
    );
  const messages: ShareMessage[] = [];
  if (root[1].length > 2000)
    throw new Error("Shared conversation exceeds the 2,000-turn limit.");
  for (const turn of root[1]) {
    const user = slot(turn, 2, 0, 0);
    const answer = slot(turn, 3, 0, 0, 1);
    if (
      typeof user !== "string" ||
      !Array.isArray(answer) ||
      !answer.every((part) => typeof part === "string")
    )
      throw new Error(
        "Gemini returned an incomplete or unsupported conversation turn.",
      );
    const content: unknown[] = user.trim() ? [user] : [];
    for (const group of array(slot(turn, 2, 0, 4))) {
      for (const file of array(slot(group, 3))) {
        const url = slot(file, 3);
        const mime = slot(file, 11);
        if (typeof url !== "string")
          throw new Error("Gemini omitted an attachment location.");
        content.push({
          fileData: {
            fileUri: url,
            mimeType:
              typeof mime === "string" ? mime : "application/octet-stream",
          },
          name:
            typeof slot(file, 2) === "string"
              ? slot(file, 2)
              : "Gemini attachment",
        });
      }
    }
    if (content.length) messages.push({ role: "user", content });
    const text = answer
      .map((part) => requiredText(part, "Gemini answer"))
      .join("");
    if (text.trim()) messages.push({ role: "assistant", content: text });
    else
      throw new Error(
        "Gemini did not include a completed answer for this turn.",
      );
  }
  // Metadata slots may contain internal state and alternate candidates.
  return validateTranscript({
    title: sourceTitle(slot(root, 2, 1), "Gemini"),
    messages,
  });
}
