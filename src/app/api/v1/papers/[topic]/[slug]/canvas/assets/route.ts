import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { NextResponse, type NextRequest } from "next/server";
import { activeProfile } from "@/lib/auth/session";
import { getPaper } from "@/lib/library/papers";

export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ topic: string; slug: string }>;
}

const MAX_ASSET_BYTES = 50 * 1024 * 1024;
const MIME_EXTENSIONS: Record<string, string> = {
  "image/gif": "gif",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
};

async function readLimitedBody(request: NextRequest): Promise<Buffer | null> {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_ASSET_BYTES) {
    return null;
  }
  if (!request.body) return Buffer.alloc(0);
  const reader = request.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_ASSET_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}

export async function POST(request: NextRequest, { params }: Params) {
  const profile = await activeProfile();
  if (!profile)
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  const { topic, slug } = await params;
  const paper = getPaper(topic, slug);
  if (!paper)
    return NextResponse.json({ error: "Unknown paper." }, { status: 404 });

  const mime = request.headers.get("content-type")?.split(";")[0] ?? "";
  const extension = MIME_EXTENSIONS[mime];
  if (!extension) {
    return NextResponse.json(
      { error: "Only images and common video files can be added." },
      { status: 415 },
    );
  }
  const bytes = await readLimitedBody(request);
  if (!bytes || bytes.length === 0) {
    return NextResponse.json(
      { error: "Canvas assets must be between 1 byte and 50 MB." },
      { status: 413 },
    );
  }

  const filename = `${createHash("sha256").update(bytes).digest("hex")}.${extension}`;
  const directory = path.join(paper.companionDir, "canvas-assets");
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, filename);
  if (!fs.existsSync(file)) {
    const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    fs.writeFileSync(tmp, bytes);
    fs.renameSync(tmp, file);
  }
  return NextResponse.json({
    src: `/api/v1/papers/${topic}/${slug}/canvas/assets/${filename}`,
  });
}
