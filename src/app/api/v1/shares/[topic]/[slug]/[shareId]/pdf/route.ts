import { NextResponse, type NextRequest } from "next/server";
import { fileResponse } from "@/lib/http/file-range";
import { getPaper } from "@/lib/library/papers";
import { readVersionedPdfFile } from "@/lib/library/pdf/file";
import { getShare, withShareFiles } from "@/lib/library/shares";
import { acquireProfileActivity } from "@/lib/auth/profile-capability";
import { PapernookIdentityStore } from "@/lib/auth/identity-store";
import { dataRoot } from "@/lib/data-dir";
import { guardStream } from "thesidedoor-core/runtime/stream";
import { isAccessError } from "thesidedoor-core/access";

export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ topic: string; slug: string; shareId: string }>;
}

const PRIVATE_CACHE_CONTROL = "private, no-cache";

const PRIVATE_HEADERS = {
  "cache-control": "private, no-store",
  "referrer-policy": "no-referrer",
  "x-robots-tag": "noindex, nofollow",
};

export async function GET(request: NextRequest, { params }: Params) {
  const { topic, slug, shareId } = await params;
  const share = getShare(topic, slug, shareId);
  const paper = share ? getPaper(topic, slug) : null;
  if (!share || !paper || share.ownerGeneration === undefined) {
    return NextResponse.json(
      { error: "Unknown share." },
      { status: 404, headers: PRIVATE_HEADERS },
    );
  }
  let release: (() => Promise<void>) | undefined;
  let streamOwnsLease = false;
  async function releaseOnce() {
    const cleanup = release;
    release = undefined;
    await cleanup?.();
  }
  try {
    release = await acquireProfileActivity(
      new PapernookIdentityStore(dataRoot()),
      {
        username: share.ownerUsername,
        generation: share.ownerGeneration,
      },
      request.signal,
    );
    withShareFiles(share, () => undefined);
    const pdf = await readVersionedPdfFile(topic, slug);
    if (!pdf) throw new Error("The shared PDF is missing.");
    const response = withShareFiles(share, () =>
      fileResponse({
        path: pdf.path,
        size: pdf.size,
        etag: pdf.etag,
        headers: request.headers,
        contentType: "application/pdf",
        filename: `${slug}.pdf`,
        cacheControl: PRIVATE_CACHE_CONTROL,
        extraHeaders: PRIVATE_HEADERS,
      }),
    );
    if (!response.body) return response;
    const stream = guardStream(response.body, {
      validate() {
        request.signal.throwIfAborted();
        withShareFiles(share, () => undefined);
      },
      release: releaseOnce,
    });
    try {
      const result = new NextResponse(stream, {
        status: response.status,
        headers: response.headers,
      });
      streamOwnsLease = true;
      return result;
    } catch (error) {
      await stream.cancel(error);
      throw error;
    }
  } catch (error) {
    if (isAccessError(error) && error.code === "unauthorized")
      return NextResponse.json(
        { error: "Unknown share." },
        { status: 404, headers: PRIVATE_HEADERS },
      );
    return NextResponse.json(
      { error: "Paper is temporarily unavailable." },
      { status: 503, headers: PRIVATE_HEADERS },
    );
  } finally {
    if (!streamOwnsLease) await releaseOnce();
  }
}
