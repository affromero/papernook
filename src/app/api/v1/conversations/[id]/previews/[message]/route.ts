import { z } from "zod";
import {
  requestIdentity,
  sharedAccess,
  accessFailure,
} from "@/lib/auth/access";
import { withProfileFiles } from "@/lib/auth/profile-capability";
import { isAccessError } from "thesidedoor-core/access";
import { crossSiteMutation } from "@/lib/auth/request-security";
import { readBoundedJson, RequestBodyError } from "@/lib/bounded-request";
import { getConversation, lockConversation } from "@/lib/conversations/store";
import { conversationDirectory } from "@/lib/conversations/assets";
import { messagePreviews } from "@/lib/conversations/previews/source";
import { previewBytes, savePreview } from "@/lib/conversations/previews/cache";

const paramsSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{24}$/),
  message: z.coerce.number().int().min(0).max(1999),
});
const bodySchema = z
  .object({
    hash: z.string().regex(/^[a-f0-9]{64}$/),
    kind: z.string().max(40),
    image: z.string().max(2_800_000),
  })
  .strict();
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string; message: string }> },
) {
  if (crossSiteMutation(request))
    return Response.json(
      { error: "Cross-site requests are not allowed." },
      { status: 403 },
    );
  const admission = await requestIdentity();
  if (!admission?.profile || !admission.capability)
    return Response.json({ error: "Not signed in." }, { status: 401 });
  const { profile, capability } = admission;
  try {
    const { id, message } = paramsSchema.parse(await context.params);
    const input = bodySchema.parse(
      await readBoundedJson(
        request,
        3 * 1024 * 1024,
        AbortSignal.timeout(10_000),
      ),
    );
    return withProfileFiles(sharedAccess().identity, capability, () => {
      const release = lockConversation(profile.username, id);
      try {
        const source = getConversation(profile.username, id)?.messages[message];
        if (!source)
          return Response.json(
            { error: "Conversation message not found." },
            { status: 404 },
          );
        if (
          !messagePreviews(source.content, source).some(
            (preview) =>
              preview.hash === input.hash && preview.kind === input.kind,
          )
        )
          return Response.json(
            {
              error:
                "This preview changed. Reload the conversation before saving it.",
            },
            { status: 409 },
          );
        savePreview(
          conversationDirectory(profile.username, id),
          input.hash,
          previewBytes(input.image),
        );
        return Response.json(
          { saved: true },
          { status: 201, headers: { "Cache-Control": "private, no-store" } },
        );
      } finally {
        release();
      }
    });
  } catch (error) {
    if (isAccessError(error)) return accessFailure(error);
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Preview could not be saved.",
      },
      {
        status:
          error instanceof RequestBodyError
            ? error.status
            : error instanceof z.ZodError
              ? 400
              : 422,
      },
    );
  }
}
