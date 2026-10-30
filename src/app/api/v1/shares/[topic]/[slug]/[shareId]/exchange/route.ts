import { z } from "zod";
import { consumeRequestLimit, publicRequestLimit } from "@/lib/auth/rate-limit";
import { clientIp, crossSiteMutation } from "@/lib/auth/request-security";
import { readBoundedJson, RequestBodyError } from "@/lib/bounded-request";
import { exportBundle } from "@/lib/sharing/bundle";
import {
  reconstructAnnotations,
  reconstructComment,
  MAX_COLLABORATIVE_PDF_BYTES,
} from "@/lib/sharing/sandbox";
import {
  authenticateParticipant,
  requestParticipant,
  publicParticipant,
  requireCollaboration,
  withCollaboration,
  withSharingTransfer,
  leaveCollaboration,
} from "@/lib/sharing/storage";
import {
  collaborationThreads,
  publishThread,
  unpublishThread,
} from "@/lib/sharing/threads";
import {
  assetsSchema,
  base64Schema,
  conversationSchema,
  labelSchema,
  MAX_CHAT_BYTES,
  revisionSchema,
  idSchema,
  secretSchema,
  SharingError,
  sharingFailure,
} from "@/lib/sharing/schema";
import {
  getShare,
  withShareFiles,
  type PaperShare,
} from "@/lib/library/shares";
import {
  PdfBusyError,
  PdfConflictError,
  readVersionedPdf,
  readVersionedPdfFile,
  rewritePdf,
} from "@/lib/library/pdf/file";
import { pdfCommentActionSchema } from "@/lib/library/pdf/comments";

const operationSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("bundle") }).strict(),
  z.object({ action: z.literal("request"), name: labelSchema }).strict(),
  z.object({ action: z.literal("status") }).strict(),
  z.object({ action: z.literal("threads") }).strict(),
  z.object({ action: z.literal("version") }).strict(),
  z.object({ action: z.literal("changes") }).strict(),
  z.object({ action: z.literal("pdf") }).strict(),
  z.object({ action: z.literal("leave") }).strict(),
  z.object({ action: z.literal("unpublish"), id: idSchema }).strict(),
  z.object({ action: z.literal("read") }).strict(),
  z
    .object({
      action: z.literal("save-pdf"),
      etag: revisionSchema,
      pdf: base64Schema,
    })
    .strict(),
  z
    .object({
      action: z.literal("comment"),
      etag: revisionSchema,
      comment: pdfCommentActionSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal("publish"),
      chat: conversationSchema,
      assets: assetsSchema,
      expected: revisionSchema.nullable(),
    })
    .strict(),
]);
const headers = {
  "cache-control": "private, no-store",
  "referrer-policy": "no-referrer",
  "x-robots-tag": "noindex, nofollow",
  "x-content-type-options": "nosniff",
  "content-security-policy":
    "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
};
type Params = {
  params: Promise<{ topic: string; slug: string; shareId: string }>;
};

function sharedResponse(
  share: PaperShare,
  token: string,
  value: unknown,
  approved = true,
): Response {
  return withShareFiles(share, () => {
    if (token) authenticateParticipant(share, token, approved);
    return Response.json(value, { headers });
  });
}

async function handleExchange(request: Request, { params }: Params) {
  try {
    const { topic, slug, shareId } = await params;
    const share = getShare(topic, slug, shareId);
    if (!share || share.mode === "view")
      throw new SharingError("Unknown transferable share.", 404);
    const token =
      request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
    // Authenticate before reading large bodies. The sole unauthenticated operation
    // is a bounded fork snapshot request, never an editing operation.
    if (!token) {
      if (request.headers.get("x-sharing-operation") !== "bundle")
        throw new SharingError("A collaboration credential is required.", 401);
      const body = z
        .object({ action: z.literal("bundle") })
        .strict()
        .safeParse(
          await readBoundedJson(request, 1024, AbortSignal.timeout(2000)),
        );
      if (!body.success)
        throw new SharingError("A collaboration credential is required.", 401);
      return withSharingTransfer(async () =>
        sharedResponse(share, "", await exportBundle(share)),
      );
    }
    if (!secretSchema.safeParse(token).success)
      throw new SharingError("Invalid collaboration credential.", 401);
    requireCollaboration(topic, slug, shareId);
    const action = request.headers.get("x-sharing-operation");
    if (action !== "request") {
      authenticateParticipant(
        share,
        token,
        action !== "status" && action !== "leave" && action !== "threads",
      );
    }
    const limit =
      action === "save-pdf"
        ? Math.ceil((MAX_COLLABORATIVE_PDF_BYTES * 4) / 3) + 64 * 1024
        : action === "publish"
          ? MAX_CHAT_BYTES
          : 2048;
    const parsed = operationSchema.safeParse(
      await readBoundedJson(
        request,
        limit,
        AbortSignal.timeout(
          action === "save-pdf" || action === "publish" ? 30_000 : 2000,
        ),
      ),
    );
    if (!parsed.success || parsed.data.action !== action || action === "bundle")
      throw new SharingError("Invalid sharing operation.");
    const body = parsed.data;
    return await withCollaboration(share, async () => {
      if (body.action === "request") {
        const participant = requestParticipant(share, token, body.name);
        return sharedResponse(
          share,
          token,
          publicParticipant(participant),
          false,
        );
      }
      const participant = authenticateParticipant(
        share,
        token,
        body.action !== "status" &&
          body.action !== "leave" &&
          body.action !== "threads",
      );
      if (body.action === "status")
        return sharedResponse(
          share,
          token,
          publicParticipant(participant),
          false,
        );
      if (body.action === "threads")
        return withSharingTransfer(async () =>
          sharedResponse(
            share,
            token,
            {
              participant: publicParticipant(participant),
              threads:
                participant.status === "approved"
                  ? collaborationThreads(share)
                  : [],
            },
            false,
          ),
        );
      if (body.action === "version" || body.action === "changes")
        return withSharingTransfer(async () => {
          const pdf = await readVersionedPdfFile(topic, slug);
          if (!pdf) throw new SharingError("Unknown paper.", 404);
          return sharedResponse(share, token, {
            etag: pdf.etag,
            ...(body.action === "changes"
              ? {
                  threads: collaborationThreads(share).map(
                    ({ id, actorId, revision }) => ({ id, actorId, revision }),
                  ),
                }
              : {}),
          });
        });
      if (body.action === "pdf")
        return withSharingTransfer(async () => {
          const pdf = await readVersionedPdf(topic, slug);
          if (!pdf) throw new SharingError("Unknown paper.", 404);
          return withShareFiles(share, () => {
            authenticateParticipant(share, token);
            return Response.json(
              {
                etag: pdf.etag,
                pdf: Buffer.from(pdf.bytes).toString("base64"),
              },
              { headers },
            );
          });
        });
      if (body.action === "leave") {
        leaveCollaboration(share, participant);
        return Response.json({ left: true }, { headers });
      }
      if (body.action === "unpublish") {
        unpublishThread(share, participant, body.id);
        return Response.json({ unpublished: true }, { headers });
      }
      if (body.action === "read")
        return withSharingTransfer(async () =>
          sharedResponse(
            share,
            token,
            await exportBundle(share, collaborationThreads(share)),
          ),
        );
      if (body.action === "save-pdf" || body.action === "comment") {
        const bytes =
          body.action === "save-pdf"
            ? Buffer.from(body.pdf, "base64")
            : Buffer.alloc(0);
        if (bytes.byteLength > MAX_COLLABORATIVE_PDF_BYTES)
          throw new SharingError(
            "The PDF exceeds the 32 MB collaboration limit.",
            413,
          );
        await rewritePdf(
          topic,
          slug,
          async (trusted) => {
            const actorId = `participant:${participant.id}`;
            const next =
              body.action === "comment"
                ? await reconstructComment(trusted, body.comment, {
                    name: participant.name,
                    id: actorId,
                  })
                : await reconstructAnnotations(trusted, bytes, {
                    id: actorId,
                    name: participant.name,
                  });
            withShareFiles(share, () => authenticateParticipant(share, token));
            return next;
          },
          body.etag,
          (commit) =>
            withShareFiles(share, () => {
              authenticateParticipant(share, token);
              commit();
            }),
        );
        withShareFiles(share, () => authenticateParticipant(share, token));
        const pdf = await readVersionedPdf(topic, slug);
        if (!pdf) throw new SharingError("Unknown paper.", 404);
        return withShareFiles(share, () => {
          authenticateParticipant(share, token);
          return Response.json(
            {
              etag: pdf.etag,
              pdf: Buffer.from(pdf.bytes).toString("base64"),
              canonicalized: true,
            },
            { headers },
          );
        });
      }
      if (body.action === "publish")
        return sharedResponse(
          share,
          token,
          publishThread(
            share,
            authenticateParticipant(share, token),
            body,
            body.expected,
          ),
        );
      throw new SharingError("Invalid sharing operation.");
    });
  } catch (error) {
    if (error instanceof RequestBodyError)
      return Response.json(
        { error: error.message },
        { status: error.status, headers },
      );
    if (error instanceof PdfConflictError)
      return Response.json({ error: error.message }, { status: 412, headers });
    if (error instanceof PdfBusyError)
      return Response.json({ error: error.message }, { status: 409, headers });
    return sharingFailure(error);
  }
}

// This bearer-only endpoint bypasses proxy body cloning so admission can reject
// unfinished uploads. Keep its request policy here, before reading any bytes.
export async function POST(request: Request, context: Params) {
  const denied = requestPolicy(request);
  if (denied) return denied;
  try {
    return secure(
      ["save-pdf", "publish", "comment"].includes(
        request.headers.get("x-sharing-operation") ?? "",
      )
        ? await withSharingTransfer(() => handleExchange(request, context))
        : await handleExchange(request, context),
    );
  } catch (error) {
    return secure(sharingFailure(error));
  }
}

function secure(response: Response): Response {
  for (const [name, value] of Object.entries(headers))
    response.headers.set(name, value);
  return response;
}

function requestPolicy(request: Request): Response | null {
  const wait = consumeRequestLimit(
    `request:${clientIp(request)}`,
    publicRequestLimit(),
    60_000,
  );
  if (wait > 0)
    return secure(
      Response.json(
        { error: "Too many requests." },
        {
          status: 429,
          headers: { "Retry-After": String(Math.ceil(wait / 1000)) },
        },
      ),
    );
  if (crossSiteMutation(request))
    return secure(
      Response.json({ error: "Cross-site request rejected." }, { status: 403 }),
    );
  return null;
}

function unsupported(request: Request): Response {
  return (
    requestPolicy(request) ??
    secure(
      Response.json(
        { error: "Use POST for sharing exchanges." },
        { status: 405, headers: { Allow: "POST" } },
      ),
    )
  );
}

export const GET = unsupported;
export const HEAD = unsupported;
export const OPTIONS = unsupported;
export const PUT = unsupported;
export const PATCH = unsupported;
export const DELETE = unsupported;
