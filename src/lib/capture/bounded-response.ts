export class ResponseTooLargeError extends Error {}

interface ReadableResponse {
  headers: { get(name: string): string | null };
  body: unknown;
}

interface ResponseBody {
  cancel(): Promise<void>;
  getReader(): {
    read(): Promise<{ done: boolean; value?: Uint8Array }>;
    cancel(): Promise<void>;
    releaseLock(): void;
  };
}

function responseBody(value: unknown): ResponseBody | null {
  if (
    !value ||
    typeof value !== "object" ||
    !("cancel" in value) ||
    !("getReader" in value)
  ) {
    return null;
  }
  return value as ResponseBody;
}

/**
 * Read a web response without trusting Content-Length. The stream is cancelled
 * as soon as the actual payload crosses the limit.
 */
export async function readBoundedResponse(
  response: ReadableResponse,
  maxBytes: number,
  close: () => Promise<void> = async () => {},
): Promise<Buffer> {
  const body = responseBody(response.body);
  const contentLength = response.headers.get("content-length");
  if (contentLength && Number(contentLength) > maxBytes) {
    await body?.cancel();
    await close();
    throw new ResponseTooLargeError(
      `Response is too large (limit ${Math.round(maxBytes / 1e6)} MB).`,
    );
  }
  const reader = body?.getReader();
  if (!reader) {
    await close();
    return Buffer.alloc(0);
  }
  let bytes = Buffer.allocUnsafe(Math.min(maxBytes, 64 * 1024));
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      const nextSize = size + value.byteLength;
      if (nextSize > maxBytes) {
        await reader.cancel();
        throw new ResponseTooLargeError(
          `Response is too large (limit ${Math.round(maxBytes / 1e6)} MB).`,
        );
      }
      if (nextSize > bytes.byteLength) {
        const grown = Buffer.allocUnsafe(
          Math.min(maxBytes, Math.max(nextSize, bytes.byteLength * 2)),
        );
        bytes.copy(grown, 0, 0, size);
        bytes = grown;
      }
      bytes.set(value, size);
      size = nextSize;
    }
  } finally {
    reader.releaseLock();
    await close();
  }
  return bytes.subarray(0, size);
}
