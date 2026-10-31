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
async function readResponse(
  response: ReadableResponse,
  maxBytes: number,
  close: () => Promise<void>,
  prefix: boolean,
): Promise<Buffer> {
  const body = responseBody(response.body);
  const contentLength = response.headers.get("content-length");
  if (!prefix && contentLength && Number(contentLength) > maxBytes) {
    try {
      await body?.cancel();
    } finally {
      await close();
    }
    throw new ResponseTooLargeError(
      `Response is too large (limit ${Math.round(maxBytes / 1e6)} MB).`,
    );
  }
  if (prefix && maxBytes === 0) {
    try {
      await body?.cancel();
    } finally {
      await close();
    }
    return Buffer.alloc(0);
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
      const { done, value: chunk } = await reader.read();
      if (done) break;
      if (!chunk) continue;
      const value = prefix ? chunk.subarray(0, maxBytes - size) : chunk;
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
      if (prefix && size === maxBytes) {
        await reader.cancel();
        break;
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } finally {
      await close();
    }
  }
  return bytes.subarray(0, size);
}

/** Read the complete response, rejecting declared or streamed oversized bodies. */
export function readBoundedResponse(
  response: ReadableResponse,
  maxBytes: number,
  close: () => Promise<void> = async () => {},
): Promise<Buffer> {
  return readResponse(response, maxBytes, close, false);
}

/** Read at most a prefix, then cancel the remaining body and close its connection. */
export function readResponsePrefix(
  response: ReadableResponse,
  maxBytes: number,
  close: () => Promise<void> = async () => {},
): Promise<Buffer> {
  return readResponse(response, maxBytes, close, true);
}
