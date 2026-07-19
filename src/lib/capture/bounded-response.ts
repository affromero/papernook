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
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new ResponseTooLargeError(
          `Response is too large (limit ${Math.round(maxBytes / 1e6)} MB).`,
        );
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
    await close();
  }
  return Buffer.concat(chunks, size);
}
