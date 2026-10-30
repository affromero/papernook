import { activeProfile } from "@/lib/auth/session";
import { readBoundedJsonOrNull } from "@/lib/bounded-request";
import { isValidSlug } from "@/lib/library/slug";
import {
  PdfCommentError,
  updatePdfComment,
  pdfCommentActionSchema,
} from "@/lib/library/pdf/comments";
import { saveConnectedComment } from "@/lib/sharing/gateway";
import { SharingError, sharingFailure } from "@/lib/sharing/schema";
import {
  PdfBusyError,
  PdfConflictError,
  PdfFileError,
  rewritePdf,
} from "@/lib/library/pdf/file";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ topic: string; slug: string }> },
) {
  const profile = await activeProfile();
  if (!profile)
    return Response.json({ error: "Not signed in." }, { status: 401 });
  const { topic, slug } = await params;
  if (!isValidSlug(topic) || !isValidSlug(slug))
    return Response.json({ error: "Invalid paper." }, { status: 400 });
  const etag = request.headers.get("if-match");
  const body = pdfCommentActionSchema.safeParse(
    await readBoundedJsonOrNull(request),
  );
  if (!etag || !/^"[a-f0-9]{64}"$/.test(etag) || !body.success)
    return Response.json(
      { error: "Invalid comment or PDF version." },
      { status: 400 },
    );
  try {
    const connected = await saveConnectedComment(topic, slug, etag, body.data);
    if (connected)
      return Response.json(connected, {
        headers: { etag: connected.etag, "cache-control": "private, no-store" },
      });
    const result = await rewritePdf(
      topic,
      slug,
      (bytes) =>
        updatePdfComment(
          bytes,
          body.data,
          profile.displayName,
          profile.username,
        ),
      etag,
    );
    return Response.json(result, {
      headers: { etag: result.etag, "cache-control": "private, no-store" },
    });
  } catch (error) {
    if (error instanceof SharingError) return sharingFailure(error);
    if (error instanceof PdfConflictError)
      return Response.json({ error: error.message }, { status: 412 });
    if (error instanceof PdfBusyError)
      return Response.json({ error: error.message }, { status: 409 });
    if (error instanceof PdfCommentError)
      return Response.json({ error: error.message }, { status: 422 });
    if (error instanceof PdfFileError)
      return Response.json({ error: error.message }, { status: 404 });
    throw error;
  }
}
