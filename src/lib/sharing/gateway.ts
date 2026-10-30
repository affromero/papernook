import fs from "node:fs";
import { z } from "zod";
import { requestIdentity } from "../auth/access";
import {
  withConnection,
  readConnection,
  saveConnection,
  type Connection,
  assertCurrentConnection,
  participantSchema,
} from "./storage";
import { exchange } from "./transport";
import {
  base64Schema,
  revisionSchema,
  SharingError,
  sharingFailure,
  publishedThreadSchema,
} from "./schema";
import { pdfEtag, readVersionedPdf, replacePdf } from "../library/pdf/file";
import { getPaper, withPaperMutation } from "../library/papers";
import { PapernookIdentityStore } from "../auth/identity-store";
import { withProfileFiles } from "../auth/profile-capability";
import { dataRoot } from "../data-dir";
import { validateSharedPdf, validateAssets } from "./bundle";
import type { PdfCommentAction } from "../library/pdf/comments";
import type { ProfileCapability } from "../auth/profile-capability";
import { MAX_COLLABORATIVE_PDF_BYTES } from "./sandbox";

const saveResultSchema = z
  .object({
    etag: revisionSchema,
    pdf: base64Schema,
    canonicalized: z.literal(true),
  })
  .strict();

export function connectionExchange(
  topic: string,
  slug: string,
  capability: ProfileCapability,
  connection: Connection,
  operation: unknown,
) {
  return exchange(connection.url, operation, connection.token, () =>
    withProfileFiles(new PapernookIdentityStore(dataRoot()), capability, () =>
      assertCurrentConnection(topic, slug, capability, connection),
    ),
  );
}

export async function connectedState(
  topic: string,
  slug: string,
  capability: ProfileCapability,
  connection: Connection,
) {
  const value = z
    .object({
      participant: participantSchema.omit({ tokenHash: true }),
      threads: z.array(publishedThreadSchema).max(100),
    })
    .strict()
    .parse(
      await connectionExchange(topic, slug, capability, connection, {
        action: "threads",
      }),
    );
  for (const thread of value.threads) validateAssets(thread);
  return value;
}

/** A WebDAV writer cannot identify a person. Preserve unrecognized local edits. */
export async function updateMirror(
  topic: string,
  slug: string,
  connection: Connection,
  bytes: Uint8Array,
  etag: string,
  capability: ProfileCapability,
) {
  validateSharedPdf(bytes, etag);
  const current = await readVersionedPdf(topic, slug);
  if (!current) throw new SharingError("The local paper was removed.", 404);
  if (current.etag !== connection.mirrorEtag && current.etag !== etag)
    throw new SharingError(
      "The local PDF changed outside collaboration. Preserve that copy before reconnecting; it has not been uploaded.",
      409,
    );
  if (current.etag !== etag)
    await replacePdf(topic, slug, current.etag, bytes, (commit) =>
      withProfileFiles(new PapernookIdentityStore(dataRoot()), capability, () =>
        withPaperMutation(slug, () => {
          assertCurrentConnection(topic, slug, capability, connection);
          commit();
        }),
      ),
    );
  saveConnection(topic, slug, capability, {
    ...connection,
    mirrorEtag: etag,
  });
}

export async function connectedPdfResponse(
  request: Request,
  topic: string,
  slug: string,
): Promise<Response | null> {
  if (!readConnection(topic, slug)) return null;
  try {
    const admission = await requestIdentity();
    if (!admission?.capability) throw new SharingError("Not signed in.", 401);
    return await withConnection(
      topic,
      slug,
      admission.capability,
      async (connection) => {
        if (request.method === "HEAD") {
          const version = z
            .object({ etag: revisionSchema })
            .strict()
            .parse(
              await connectionExchange(
                topic,
                slug,
                admission.capability!,
                connection,
                { action: "version" },
              ),
            );
          return new Response(null, {
            headers: {
              etag: version.etag,
              "cache-control": "private, no-store",
            },
          });
        }
        const bundle = z
          .object({ etag: revisionSchema, pdf: base64Schema })
          .strict()
          .parse(
            await connectionExchange(
              topic,
              slug,
              admission.capability!,
              connection,
              { action: "pdf" },
            ),
          );
        const bytes = Buffer.from(bundle.pdf, "base64");
        if (pdfEtag(bytes) !== bundle.etag)
          throw new SharingError(
            "The sharing server returned an invalid PDF version.",
            502,
          );
        await updateMirror(
          topic,
          slug,
          connection,
          bytes,
          bundle.etag,
          admission.capability!,
        );
        return new Response(request.method === "HEAD" ? null : bytes, {
          headers: {
            "Content-Type": "application/pdf",
            etag: bundle.etag,
            "cache-control": "private, no-store",
          },
        });
      },
    );
  } catch (error) {
    return sharingFailure(error);
  }
}

export async function saveConnectedPdf(
  topic: string,
  slug: string,
  expected: string,
  bytes: Uint8Array,
): Promise<{ etag: string; canonicalized: true } | null> {
  if (!readConnection(topic, slug)) return null;
  if (bytes.byteLength > MAX_COLLABORATIVE_PDF_BYTES)
    throw new SharingError(
      "Collaborative annotation saves support PDFs up to 32 MB.",
      413,
    );
  return saveConnected(topic, slug, {
    action: "save-pdf",
    etag: expected,
    pdf: Buffer.from(bytes).toString("base64"),
  });
}

export async function saveConnectedComment(
  topic: string,
  slug: string,
  expected: string,
  comment: PdfCommentAction,
) {
  return saveConnected(topic, slug, {
    action: "comment",
    etag: expected,
    comment,
  });
}

async function saveConnected(
  topic: string,
  slug: string,
  operation: unknown,
): Promise<{ etag: string; canonicalized: true } | null> {
  if (!readConnection(topic, slug)) return null;
  const admission = await requestIdentity();
  if (!admission?.capability) throw new SharingError("Not signed in.", 401);
  return withConnection(
    topic,
    slug,
    admission.capability,
    async (connection) => {
      const result = saveResultSchema.parse(
        await connectionExchange(
          topic,
          slug,
          admission.capability!,
          connection,
          operation,
        ),
      );
      const canonical = Buffer.from(result.pdf, "base64");
      if (pdfEtag(canonical) !== result.etag)
        throw new SharingError(
          "The saved PDF version could not be verified.",
          502,
        );
      await updateMirror(
        topic,
        slug,
        connection,
        canonical,
        result.etag,
        admission.capability!,
      );
      return { etag: result.etag, canonicalized: true };
    },
  );
}

export function localMirrorChanged(
  topic: string,
  slug: string,
  connection: Connection,
): boolean {
  const paper = getPaper(topic, slug);
  return (
    !paper || pdfEtag(fs.readFileSync(paper.pdfPath)) !== connection.mirrorEtag
  );
}
