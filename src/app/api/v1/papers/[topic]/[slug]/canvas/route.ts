import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { activeProfile } from "@/lib/auth/session";
import { getPaper } from "@/lib/library/papers";

export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ topic: string; slug: string }>;
}

const MAX_CANVAS_BYTES = 20 * 1024 * 1024;
const snapshotSchema = z.object({ document: z.unknown() }).strict();
const EMPTY_ETAG = '"empty"';

function etagFor(raw: string): string {
  return `"${createHash("sha256").update(raw).digest("base64url")}"`;
}

function readCanvas(file: string): {
  body: { document: unknown | null };
  etag: string;
} {
  if (!fs.existsSync(file)) {
    return { body: { document: null }, etag: EMPTY_ETAG };
  }
  const raw = fs.readFileSync(file, "utf8");
  const parsed: unknown = JSON.parse(raw);
  if (parsed && typeof parsed === "object" && "document" in parsed) {
    return {
      body: { document: parsed.document },
      etag: etagFor(raw),
    };
  }
  return { body: { document: parsed }, etag: etagFor(raw) };
}

export async function GET(_request: NextRequest, { params }: Params) {
  const profile = await activeProfile();
  if (!profile)
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  const { topic, slug } = await params;
  const paper = getPaper(topic, slug);
  if (!paper)
    return NextResponse.json({ error: "Unknown paper." }, { status: 404 });
  try {
    const canvas = readCanvas(path.join(paper.companionDir, "canvas.json"));
    return NextResponse.json(canvas.body, {
      headers: { etag: canvas.etag, "cache-control": "no-store" },
    });
  } catch {
    return NextResponse.json(
      { error: "The saved canvas is invalid." },
      { status: 500 },
    );
  }
}

export async function PUT(request: NextRequest, { params }: Params) {
  const profile = await activeProfile();
  if (!profile)
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  const { topic, slug } = await params;
  const paper = getPaper(topic, slug);
  if (!paper)
    return NextResponse.json({ error: "Unknown paper." }, { status: 404 });

  const raw = await request.text();
  if (Buffer.byteLength(raw) > MAX_CANVAS_BYTES) {
    return NextResponse.json({ error: "Canvas too large." }, { status: 413 });
  }
  const body = snapshotSchema.safeParse(
    (() => {
      try {
        return JSON.parse(raw) as unknown;
      } catch {
        return null;
      }
    })(),
  );
  if (!body.success) {
    return NextResponse.json({ error: "Invalid canvas." }, { status: 400 });
  }

  const file = path.join(paper.companionDir, "canvas.json");
  let current: ReturnType<typeof readCanvas>;
  try {
    current = readCanvas(file);
  } catch {
    return NextResponse.json(
      { error: "The saved canvas is invalid." },
      { status: 500 },
    );
  }
  if (request.headers.get("if-match") !== current.etag) {
    return NextResponse.json(
      {
        error:
          "This canvas changed on another device. Reload before adding more.",
      },
      { status: 409, headers: { etag: current.etag } },
    );
  }

  const serialized = JSON.stringify(body.data);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, serialized);
  fs.renameSync(tmp, file);
  return NextResponse.json(
    { ok: true },
    { headers: { etag: etagFor(serialized) } },
  );
}
