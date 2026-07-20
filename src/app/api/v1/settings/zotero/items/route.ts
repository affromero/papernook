import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { readBoundedJsonOrNull } from "@/lib/bounded-request";
import { activeProfile } from "@/lib/auth/session";
import {
  importCatalogItem,
  listCatalogItems,
  ZoteroCatalogItemNotFoundError,
  ZoteroImportUnavailableError,
} from "@/lib/capture/zotero-service";
import { ZoteroError, ZoteroPdfTooLargeError } from "@/lib/capture/zotero";
import { ZoteroBusyError } from "@/lib/capture/zotero-lock";

export const dynamic = "force-dynamic";

const querySchema = z.object({
  q: z.string().max(200).default(""),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export async function GET(request: NextRequest): Promise<NextResponse> {
  const profile = await activeProfile();
  if (!profile) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }
  if (!profile.zotero) {
    return NextResponse.json(
      { error: "Zotero not connected." },
      { status: 400 },
    );
  }
  const query = querySchema.safeParse({
    q: request.nextUrl.searchParams.get("q") ?? undefined,
    page: request.nextUrl.searchParams.get("page") ?? undefined,
    limit: request.nextUrl.searchParams.get("limit") ?? undefined,
  });
  if (!query.success) {
    return NextResponse.json(
      { error: "Invalid Zotero catalog query." },
      { status: 400 },
    );
  }
  return NextResponse.json(
    await listCatalogItems(
      profile.username,
      query.data.q,
      query.data.page,
      query.data.limit,
    ),
  );
}

const importSchema = z.object({
  itemKey: z.string().regex(/^[A-Za-z0-9]{1,64}$/),
});

export async function POST(request: NextRequest): Promise<NextResponse> {
  const profile = await activeProfile();
  if (!profile) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }
  const body = importSchema.safeParse(await readBoundedJsonOrNull(request));
  if (!body.success) {
    return NextResponse.json(
      { error: "Invalid Zotero item." },
      { status: 400 },
    );
  }
  try {
    const result = await importCatalogItem(profile.username, body.data.itemKey);
    return NextResponse.json(result, { status: result.created ? 201 : 200 });
  } catch (error) {
    if (error instanceof ZoteroCatalogItemNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    if (error instanceof ZoteroBusyError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof ZoteroPdfTooLargeError) {
      return NextResponse.json({ error: error.message }, { status: 413 });
    }
    if (error instanceof ZoteroImportUnavailableError) {
      return NextResponse.json({ error: error.message }, { status: 422 });
    }
    if (error instanceof ZoteroError) {
      return NextResponse.json({ error: error.message }, { status: 502 });
    }
    throw error;
  }
}
