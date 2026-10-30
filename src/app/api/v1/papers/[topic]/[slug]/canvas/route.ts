import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { activeProfile } from "@/lib/auth/session";
import { readBoundedJson } from "@/lib/bounded-request";
import {
  readCanvas,
  saveCanvas,
  MAX_CANVAS_BYTES,
  CANVAS_VERSION_HEADER,
} from "@/lib/canvas/document";
import { CanvasError } from "@/lib/canvas/errors";
import {
  connectedCanvas,
  saveConnectedCanvas,
} from "@/lib/sharing/artifacts/gateway";
import {
  hasCollaboration,
  localArtifactAuthority,
} from "@/lib/sharing/artifacts/local";
import { saveSourceCanvas } from "@/lib/sharing/artifacts/source";
import { sharingFailure } from "@/lib/sharing/schema";

export const dynamic = "force-dynamic";
interface Params {
  params: Promise<{ topic: string; slug: string }>;
}
const snapshotSchema = z.object({ document: z.unknown() }).strict();
function versionHeaders(version: string) {
  return {
    etag: version,
    [CANVAS_VERSION_HEADER]: version,
    "cache-control": "private, no-store",
  };
}

export async function GET(_request: NextRequest, { params }: Params) {
  if (!(await activeProfile()))
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  const { topic, slug } = await params;
  try {
    const canvas =
      (await connectedCanvas(topic, slug)) ?? readCanvas(topic, slug);
    return NextResponse.json(
      { document: canvas.document },
      { headers: versionHeaders(canvas.version) },
    );
  } catch (error) {
    if (error instanceof SyntaxError)
      return NextResponse.json(
        { error: "The saved canvas is invalid." },
        { status: 500 },
      );
    return sharingFailure(error);
  }
}

export async function PUT(request: NextRequest, { params }: Params) {
  if (!(await activeProfile()))
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  const { topic, slug } = await params;
  try {
    const body = snapshotSchema.safeParse(
      await readBoundedJson(
        request,
        MAX_CANVAS_BYTES,
        AbortSignal.timeout(30_000),
      ),
    );
    if (!body.success)
      return NextResponse.json({ error: "Invalid canvas." }, { status: 400 });
    const version =
      request.headers.get(CANVAS_VERSION_HEADER) ??
      request.headers.get("if-match") ??
      "";
    const connected = await saveConnectedCanvas(
      topic,
      slug,
      version,
      body.data.document,
    );
    if (connected)
      return NextResponse.json(
        { ok: true, document: connected.document },
        { headers: versionHeaders(connected.version) },
      );
    if (hasCollaboration(topic, slug)) {
      const authority = await localArtifactAuthority();
      const saved = saveSourceCanvas(
        topic,
        slug,
        version,
        body.data.document,
        authority.actor,
        authority.commit,
        false,
      );
      return NextResponse.json(
        { ok: true, document: readCanvas(topic, slug).document },
        { headers: versionHeaders(saved.version) },
      );
    }
    const saved = saveCanvas(topic, slug, version, body.data.document);
    return NextResponse.json({ ok: true }, { headers: versionHeaders(saved) });
  } catch (error) {
    if (error instanceof CanvasError && error.status === 409)
      return NextResponse.json(
        { error: error.message },
        {
          status: 409,
          headers: versionHeaders(readCanvas(topic, slug).version),
        },
      );
    return sharingFailure(error);
  }
}
