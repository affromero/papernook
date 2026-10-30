export class RequestBodyError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 413,
  ) {
    super(message);
  }
}

export async function readBoundedBytes(
  request: Request,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const declared = request.headers.get("content-length");
  if (declared && Number(declared) > maxBytes) {
    throw new RequestBodyError("Request body too large.", 413);
  }
  if (!request.body) return new Uint8Array();

  const reader = request.body.getReader();
  let bytes = new Uint8Array(Math.min(maxBytes, 16 * 1024));
  let total = 0;
  const { promise: aborted, reject: rejectAbort } =
    Promise.withResolvers<never>();
  const abortRead = () => {
    void reader.cancel().catch(() => {});
    rejectAbort(new RequestBodyError("Request body timed out.", 400));
  };
  if (signal?.aborted) abortRead();
  else signal?.addEventListener("abort", abortRead, { once: true });
  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (signal?.aborted)
        throw new RequestBodyError("Request body timed out.", 400);
      if (done) break;
      const nextSize = total + value.byteLength;
      if (nextSize > maxBytes) {
        await reader.cancel();
        throw new RequestBodyError("Request body too large.", 413);
      }
      if (nextSize > bytes.byteLength) {
        const grown = new Uint8Array(
          Math.min(maxBytes, Math.max(nextSize, bytes.byteLength * 2)),
        );
        grown.set(bytes.subarray(0, total));
        bytes = grown;
      }
      bytes.set(value, total);
      total = nextSize;
    }
  } finally {
    signal?.removeEventListener("abort", abortRead);
    reader.releaseLock();
  }
  return bytes.subarray(0, total);
}

export async function readBoundedText(
  request: Request,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<string> {
  return new TextDecoder("utf-8", { fatal: true }).decode(
    await readBoundedBytes(request, maxBytes, signal),
  );
}

/**
 * Bound the body first, then parse it as a form (url-encoded or multipart).
 * Reading through readBoundedText caps memory and closes the chunked-transfer
 * bypass of a Content-Length-only check; reconstructing the Request lets the
 * platform decode whichever encoding the client actually sent.
 */
export async function readBoundedForm(
  request: Request,
  maxBytes: number,
): Promise<URLSearchParams> {
  const raw = await readBoundedText(request, maxBytes);
  const contentType = request.headers.get("content-type") ?? "";
  const parsed = await new Request("http://form.local", {
    method: "POST",
    headers: contentType ? { "content-type": contentType } : undefined,
    body: raw,
  })
    .formData()
    .catch(() => {
      throw new RequestBodyError("Invalid form body.", 400);
    });
  const form = new URLSearchParams();
  for (const [key, value] of parsed) {
    if (typeof value === "string") form.append(key, value);
  }
  return form;
}

export async function readBoundedJson(
  request: Request,
  maxBytes = 64 * 1024,
  signal?: AbortSignal,
): Promise<unknown> {
  try {
    return JSON.parse(
      await readBoundedText(request, maxBytes, signal),
    ) as unknown;
  } catch (error) {
    if (error instanceof RequestBodyError) throw error;
    throw new RequestBodyError("Invalid JSON body.", 400);
  }
}

export async function readBoundedJsonOrNull(
  request: Request,
  maxBytes = 64 * 1024,
): Promise<unknown | null> {
  try {
    return await readBoundedJson(request, maxBytes);
  } catch {
    return null;
  }
}
