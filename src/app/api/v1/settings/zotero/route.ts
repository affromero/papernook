import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { readBoundedJsonOrNull } from "@/lib/bounded-request";
import { activeProfile } from "@/lib/auth/session";
import {
  recordFailure,
  recordSuccess,
  retryAfterMs,
} from "@/lib/auth/rate-limit";
import {
  verifyKey,
  syncProfile,
  isSyncing,
  lastSyncResult,
  listLibraryTargets,
  listCollections,
} from "@/lib/capture/zotero";
import {
  disconnectZotero,
  saveZoteroConfig,
} from "@/lib/capture/zotero-service";
import { ZoteroBusyError } from "@/lib/capture/zotero-lock";
import type {
  Profile,
  ZoteroLibraryTarget,
  ZoteroProfileConfig,
} from "@/lib/auth/users";

/**
 * Per-profile Zotero connection: connect with an API key (verified against
 * the Zotero API, which also discovers the user ID), disconnect, and trigger
 * a sync. The key itself is never returned to the browser.
 */

export const dynamic = "force-dynamic";

function configuredTarget(config: ZoteroProfileConfig): ZoteroLibraryTarget {
  return (
    config.target ?? {
      type: "user",
      id: config.userId,
      name: "My Library",
    }
  );
}

function snapshot(profile: Profile) {
  return {
    connected: Boolean(profile.zotero),
    userId: profile.zotero?.userId ?? null,
    target: profile.zotero ? configuredTarget(profile.zotero) : null,
    collectionKeys: profile.zotero?.collectionKeys ?? [],
    syncing: isSyncing(profile.username),
    lastResult: lastSyncResult(profile.username),
  };
}

const optionsQuerySchema = z.object({
  options: z.literal("1").optional(),
  libraryType: z.enum(["user", "group"]).optional(),
  libraryId: z.string().regex(/^\d+$/).optional(),
});

export async function GET(request?: NextRequest): Promise<NextResponse> {
  const me = await activeProfile();
  if (!me)
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  const query = optionsQuerySchema.safeParse({
    options: request?.nextUrl.searchParams.get("options") ?? undefined,
    libraryType: request?.nextUrl.searchParams.get("libraryType") ?? undefined,
    libraryId: request?.nextUrl.searchParams.get("libraryId") ?? undefined,
  });
  if (!query.success) {
    return NextResponse.json(
      { error: "Invalid Zotero options request." },
      { status: 400 },
    );
  }
  if (query.data.options === "1") {
    if (!me.zotero) {
      return NextResponse.json(
        { error: "Zotero not connected." },
        { status: 400 },
      );
    }
    const verified = await verifyKey(me.zotero.apiKey);
    if (!verified) {
      return NextResponse.json(
        { error: "Zotero rejected this key. Reconnect it to continue." },
        { status: 422 },
      );
    }
    const personalReadable = verified.personalLibrary;
    const libraries = await listLibraryTargets(me.zotero, personalReadable);
    if (libraries.length === 0) {
      return NextResponse.json(
        { error: "This key cannot read any Zotero library metadata." },
        { status: 422 },
      );
    }
    let target = configuredTarget(me.zotero);
    let warning: string | null = null;
    if (query.data.libraryType || query.data.libraryId) {
      if (!query.data.libraryType || !query.data.libraryId) {
        return NextResponse.json(
          { error: "Choose a complete Zotero library target." },
          { status: 400 },
        );
      }
      const requested = libraries.find(
        (library) =>
          library.type === query.data.libraryType &&
          library.id === query.data.libraryId,
      );
      if (!requested) {
        return NextResponse.json(
          { error: "That Zotero library is not accessible with this key." },
          { status: 422 },
        );
      }
      target = requested;
    } else if (
      !libraries.some(
        (library) => library.type === target.type && library.id === target.id,
      )
    ) {
      target = libraries[0];
      warning =
        "The configured Zotero group is no longer accessible. Choose another library.";
    }
    const collections = await listCollections({
      ...me.zotero,
      target,
    });
    return NextResponse.json({
      ...snapshot(me),
      libraries: libraries.map((library) => ({
        ...library,
        canImportFiles:
          library.type === "group" ? null : verified.personalFiles,
      })),
      collections,
      previewTarget: target,
      warning,
    });
  }
  return NextResponse.json(snapshot(me));
}

const schema = z.object({ apiKey: z.string().min(8).max(128) });

export async function PUT(request: NextRequest): Promise<NextResponse> {
  const me = await activeProfile();
  if (!me)
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  if (isSyncing(me.username)) {
    return NextResponse.json(
      { error: "Wait for the current Zotero sync to finish." },
      { status: 409 },
    );
  }
  const limitKey = `zotero-key:${me.username}`;
  if (retryAfterMs(limitKey) > 0) {
    return NextResponse.json(
      { error: "Too many attempts. Try again shortly." },
      { status: 429 },
    );
  }
  const body = schema.safeParse(await readBoundedJsonOrNull(request));
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
  const personalReadable = verified.personalLibrary;
  const config = {
    apiKey: body.data.apiKey.trim(),
    userId: verified.userId,
  };
  const libraries = await listLibraryTargets(config, personalReadable);
  if (libraries.length === 0) {
    recordFailure(limitKey);
    return NextResponse.json(
      {
        error: "This key cannot read a personal or group Zotero library.",
      },
      { status: 422 },
    );
  }
  recordSuccess(limitKey);
  const target = personalReadable
    ? libraries.find((library) => library.type === "user")!
    : libraries[0];
  try {
    const profile = await saveZoteroConfig(me.username, {
      ...config,
      target,
      collectionKeys: [],
    });
    return NextResponse.json(snapshot(profile));
  } catch (error) {
    if (error instanceof ZoteroBusyError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    throw error;
  }
}

export async function DELETE(): Promise<NextResponse> {
  const me = await activeProfile();
  if (!me)
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  if (isSyncing(me.username)) {
    return NextResponse.json(
      { error: "Wait for the current Zotero sync to finish." },
      { status: 409 },
    );
  }
  try {
    await disconnectZotero(me.username);
    const disconnected = { ...me };
    delete disconnected.zotero;
    return NextResponse.json(snapshot(disconnected));
  } catch (error) {
    if (error instanceof ZoteroBusyError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    throw error;
  }
}

const targetSchema = z.object({
  type: z.enum(["user", "group"]),
  id: z.string().regex(/^\d+$/),
});
const updateSchema = z.object({
  target: targetSchema,
  collectionKeys: z.array(z.string().min(1).max(64)).max(1_000).default([]),
});

export async function PATCH(request: NextRequest): Promise<NextResponse> {
  const me = await activeProfile();
  if (!me)
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  if (!me.zotero) {
    return NextResponse.json(
      { error: "Zotero not connected." },
      { status: 400 },
    );
  }
  if (isSyncing(me.username)) {
    return NextResponse.json(
      { error: "Wait for the current Zotero sync to finish." },
      { status: 409 },
    );
  }
  const body = updateSchema.safeParse(await readBoundedJsonOrNull(request));
  if (!body.success) {
    return NextResponse.json(
      { error: "Invalid Zotero sync source." },
      { status: 400 },
    );
  }
  const verified = await verifyKey(me.zotero.apiKey);
  if (!verified) {
    return NextResponse.json(
      { error: "Zotero rejected this key. Reconnect it to continue." },
      { status: 422 },
    );
  }
  const libraries = await listLibraryTargets(
    me.zotero,
    verified.personalLibrary,
  );
  const target = libraries.find(
    (library) =>
      library.type === body.data.target.type &&
      library.id === body.data.target.id,
  );
  if (!target) {
    return NextResponse.json(
      { error: "That Zotero library is not accessible with this key." },
      { status: 422 },
    );
  }
  const proposed = { ...me.zotero, target };
  const collections = await listCollections(proposed);
  const available = new Set(collections.map((collection) => collection.key));
  const collectionKeys = [...new Set(body.data.collectionKeys)].sort();
  if (collectionKeys.some((key) => !available.has(key))) {
    return NextResponse.json(
      { error: "One or more Zotero collections are not accessible." },
      { status: 422 },
    );
  }
  try {
    const profile = await saveZoteroConfig(me.username, {
      ...proposed,
      collectionKeys,
    });
    return NextResponse.json(snapshot(profile));
  } catch (error) {
    if (error instanceof ZoteroBusyError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    throw error;
  }
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
