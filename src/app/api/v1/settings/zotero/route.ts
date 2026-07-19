import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { activeProfile } from "@/lib/auth/session";
import { setZoteroConfig } from "@/lib/auth/users";
import {
  recordFailure,
  recordSuccess,
  retryAfterMs,
} from "@/lib/auth/rate-limit";
import { verifyKey, syncProfile, isSyncing } from "@/lib/capture/zotero";

/**
 * Per-profile Zotero connection: connect with an API key (verified against
 * the Zotero API, which also discovers the user ID), disconnect, and trigger
 * a sync. The key itself is never returned to the browser.
 */

export const dynamic = "force-dynamic";

function snapshot(profile: { zotero?: { userId: string }; username: string }) {
  return {
    connected: Boolean(profile.zotero),
    userId: profile.zotero?.userId ?? null,
    syncing: isSyncing(profile.username),
  };
}

export async function GET(): Promise<NextResponse> {
  const me = await activeProfile();
  if (!me)
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  return NextResponse.json(snapshot(me));
}

const schema = z.object({ apiKey: z.string().min(8).max(128) });

export async function PUT(request: NextRequest): Promise<NextResponse> {
  const me = await activeProfile();
  if (!me)
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  const limitKey = `zotero-key:${me.username}`;
  if (retryAfterMs(limitKey) > 0) {
    return NextResponse.json(
      { error: "Too many attempts. Try again shortly." },
      { status: 429 },
    );
  }
  const body = schema.safeParse(await request.json().catch(() => null));
  if (!body.success) {
    return NextResponse.json({ error: "Invalid API key." }, { status: 400 });
  }
  const verified = await verifyKey(body.data.apiKey.trim());
  if (!verified) {
    recordFailure(limitKey);
    return NextResponse.json(
      { error: "Zotero rejected this key." },
      { status: 422 },
    );
  }
  recordSuccess(limitKey);
  const profile = setZoteroConfig(me.username, {
    apiKey: body.data.apiKey.trim(),
    userId: verified.userId,
  });
  return NextResponse.json(snapshot(profile));
}

export async function DELETE(): Promise<NextResponse> {
  const me = await activeProfile();
  if (!me)
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  return NextResponse.json(snapshot(setZoteroConfig(me.username, null)));
}

/** Kick off a sync in the background; poll GET for completion. */
const lastManualSync = new Map<string, number>();
const MANUAL_SYNC_COOLDOWN_MS = 60_000;

export async function POST(): Promise<NextResponse> {
  const me = await activeProfile();
  if (!me)
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  if (!me.zotero) {
    return NextResponse.json(
      { error: "Zotero not connected." },
      { status: 400 },
    );
  }
  const last = lastManualSync.get(me.username) ?? 0;
  if (!isSyncing(me.username) && Date.now() - last < MANUAL_SYNC_COOLDOWN_MS) {
    return NextResponse.json(
      { error: "Synced moments ago. Try again in a minute." },
      { status: 429 },
    );
  }
  lastManualSync.set(me.username, Date.now());
  void syncProfile(me.username).catch((error) =>
    console.error(`zotero sync now failed for ${me.username}:`, error),
  );
  return NextResponse.json({ ...snapshot(me), syncing: true });
}
