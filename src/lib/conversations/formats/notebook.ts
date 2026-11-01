import { fenceCode } from "@/lib/chat/format/fence";
import { object, text } from "./schema";

export function notebookText(value: unknown): string {
  if (typeof value === "string") return value;
  return Array.isArray(value) ? value.map(text).join("") : "";
}

/** Preserve the complete MIME bundle, including alternatives and saved widget state. */
export function notebookOutput(
  value: unknown,
  widgetState?: unknown,
): string | null {
  const output = object(value);
  if (!output) return null;
  const type = output.output_type ?? output.msg_type;
  if (type === "stream") return fenceCode(notebookText(output.text), "text");
  if (type === "error")
    return fenceCode(
      (Array.isArray(output.traceback)
        ? output.traceback.map(text).join("\n")
        : text(output.traceback)) ||
        `${text(output.ename)}: ${text(output.evalue)}`,
      "text",
    );
  if (type !== "display_data" && type !== "execute_result") return null;
  const payload = object(output.content) ?? output;
  if (!object(payload.data))
    throw new Error("Notebook output is missing its MIME bundle.");
  const widget = Object.hasOwn(
    object(payload.data)!,
    "application/vnd.jupyter.widget-view+json",
  );
  const serialized = JSON.stringify({
    ...payload,
    ...(!widget || widgetState === undefined ? {} : { widgetState }),
  });
  if (serialized.length > 500_000)
    throw new Error("Notebook output exceeds the message limit.");
  return fenceCode(serialized, "notebook-preview");
}

export function notebookTranscript(
  value: unknown,
): { role: "user" | "assistant"; content: string }[] | null {
  const notebook = object(value);
  if (notebook?.nbformat !== 4 || !Array.isArray(notebook.cells)) return null;
  const widgets = object(object(notebook.metadata)?.widgets)?.[
    "application/vnd.jupyter.widget-state+json"
  ];
  const metadata = object(notebook.metadata);
  const language =
    text(
      object(metadata?.language_info)?.name ??
        object(metadata?.kernelspec)?.language,
    ) || "text";
  let total = 0;
  const encoder = new TextEncoder();
  return notebook.cells.flatMap((value) => {
    const cell = object(value);
    if (!cell) throw new Error("Invalid notebook cell.");
    const source = notebookText(cell.source);
    const outputs: string[] = [];
    let length = source.length;
    if (Array.isArray(cell.outputs))
      for (const value of cell.outputs) {
        const output = notebookOutput(value, widgets);
        if (!output) continue;
        length += output.length;
        total += encoder.encode(output).length;
        if (length > 500_000 || total > 4 * 1024 * 1024)
          throw new Error(
            "Notebook display data exceeds the transcript limit.",
          );
        outputs.push(output);
      }
    total += encoder.encode(source).length;
    if (total > 4 * 1024 * 1024)
      throw new Error("Notebook display data exceeds the transcript limit.");
    const output = outputs.join("\n\n");
    const content = [
      cell.cell_type === "code" && source
        ? fenceCode(source, language)
        : source,
      output,
    ]
      .filter(Boolean)
      .join("\n\n");
    return content ? [{ role: "assistant" as const, content }] : [];
  });
}
