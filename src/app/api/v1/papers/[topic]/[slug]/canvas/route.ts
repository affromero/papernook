import { NextResponse, type NextRequest } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { activeProfile } from "@/lib/auth/session";
import { getPaper } from "@/lib/library/papers";

/**
 * Canvas persistence: the tldraw store snapshot lives as canvas.json in the
 * companion folder, filesystem truth like everything else. Shared between
 * profiles (the canvas is part of the paper's workspace, like ink).
 */

export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ topic: string; slug: string }>;
}

const MAX_CANVAS_BYTES = 20 * 1024 * 1024;

export async function GET(_req: NextRequest, { params }: Params) {
  const profile = await activeProfile();
  if (!profile)
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  const { topic, slug } = await params;
  const paper = getPaper(topic, slug);
  if (!paper)
    return NextResponse.json({ error: "Unknown paper." }, { status: 404 });
  try {
    const raw = fs.readFileSync(
      path.join(paper.companionDir, "canvas.json"),
      "utf8",
    );
    return new NextResponse(raw, {
      headers: { "content-type": "application/json" },
    });
  } catch {
    return NextResponse.json({ empty: true });
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
  if (raw.length > MAX_CANVAS_BYTES) {
    return NextResponse.json({ error: "Canvas too large." }, { status: 413 });
  }
  try {
    JSON.parse(raw); // must at least be JSON
  } catch {
    return NextResponse.json({ error: "Invalid canvas." }, { status: 400 });
  }
  const file = path.join(paper.companionDir, "canvas.json");
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, raw);
  fs.renameSync(tmp, file);
  return NextResponse.json({ ok: true });
}
