import { createContext, destroyContext, domToPng } from "modern-screenshot";

export function enableSnapshots(
  ready: Promise<unknown>,
  canvasOnly = false,
  redraw?: () => HTMLCanvasElement | null,
): void {
  if (window.parent === window || globalThis.origin !== "null") return;
  let busy = false;
  let captures = 0;
  window.addEventListener("message", (event: MessageEvent<unknown>) => {
    const value = event.data;
    if (
      event.source !== window.parent ||
      !value ||
      typeof value !== "object" ||
      !("type" in value) ||
      value.type !== "papernook-preview-capture" ||
      !("nonce" in value) ||
      typeof value.nonce !== "string" ||
      !/^[a-f0-9-]{36}$/.test(value.nonce) ||
      busy ||
      captures++ >= 16
    )
      return;
    const nonce = value.nonce;
    busy = true;
    void (async () => {
      try {
        await ready;
        const image = canvasOnly
          ? await new Promise<string>((resolve, reject) =>
              requestAnimationFrame(() => {
                try {
                  const canvas = redraw?.() ?? document.querySelector("canvas");
                  if (
                    !canvas ||
                    canvas.width > 4096 ||
                    canvas.height > 4096 ||
                    canvas.width * canvas.height > 4_000_000
                  )
                    throw new Error(
                      "Scene canvas is unavailable or exceeds the snapshot limit.",
                    );
                  resolve(canvas.toDataURL("image/png"));
                } catch (error) {
                  reject(error);
                }
              }),
            )
          : await (async () => {
              const width = Math.ceil(document.body.scrollWidth);
              const height = Math.ceil(document.body.scrollHeight);
              if (
                width > 1600 ||
                height > 2400 ||
                document.body.querySelectorAll("*").length > 10_000
              )
                throw new Error(
                  "This preview is too large to capture as one image.",
                );
              const context = await createContext(document.body, {
                width,
                height,
                scale: 1,
                font: false,
                workerNumber: 0,
                timeout: 5000,
                backgroundColor: "#ffffff",
                fetchFn: async (url) => {
                  if (url.startsWith("data:")) return url;
                  throw new Error(
                    "Only included images can be captured for export.",
                  );
                },
              });
              // An unattached baseline frame has no window. Copy full computed styles
              // without reading a nested opaque frame, which Safari correctly blocks.
              context.sandbox = document.createElement("iframe");
              try {
                return await domToPng(context);
              } finally {
                destroyContext(context);
              }
            })();
        if (
          !image.startsWith("data:image/png;base64,") ||
          image.length > 2_800_000
        )
          throw new Error("Preview image exceeds the 2 MB snapshot limit.");
        parent.postMessage(
          { type: "papernook-preview-image", nonce, image },
          "*",
        );
      } catch (error) {
        parent.postMessage(
          {
            type: "papernook-preview-image",
            nonce,
            error: (error instanceof Error
              ? error.message
              : "Snapshot unavailable."
            ).slice(0, 500),
          },
          "*",
        );
      } finally {
        busy = false;
      }
    })();
  });
}
