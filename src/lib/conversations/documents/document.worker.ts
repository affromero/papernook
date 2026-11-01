import { documentPreview } from "./parse";

globalThis.onmessage = (event: MessageEvent<unknown>) => {
  try {
    const value = event.data;
    if (
      !value ||
      typeof value !== "object" ||
      !("bytes" in value) ||
      !(value.bytes instanceof ArrayBuffer) ||
      !("name" in value) ||
      typeof value.name !== "string" ||
      !("mime" in value) ||
      typeof value.mime !== "string"
    )
      throw new Error("Invalid document preview request.");
    globalThis.postMessage({
      ok: true,
      document: documentPreview(
        new Uint8Array(value.bytes),
        value.name,
        value.mime,
      ),
    });
  } catch (error) {
    globalThis.postMessage({
      ok: false,
      error: (error instanceof Error
        ? error.message
        : "Document preview failed."
      ).slice(0, 1000),
    });
  }
};
