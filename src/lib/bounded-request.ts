export class RequestBodyError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 413,
  ) {
    super(message);
  }
}

export async function readBoundedText(
  request: Request,
  maxBytes: number,
): Promise<string> {
  const declared = request.headers.get("content-length");
  if (declared && Number(declared) > maxBytes) {
    throw new RequestBodyError("Request body too large.", 413);
  }
  if (!request.body) return "";

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new RequestBodyError("Request body too large.", 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

export async function readBoundedJson(
  request: Request,
  maxBytes = 64 * 1024,
): Promise<unknown> {
  try {
    return JSON.parse(await readBoundedText(request, maxBytes)) as unknown;
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
