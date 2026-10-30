import { z } from "zod";
import {
  requestIdentity,
  sharedAccess,
  accessFailure,
} from "@/lib/auth/access";
import { withProfileFiles } from "@/lib/auth/profile-capability";
import { isAccessError } from "thesidedoor-core/access";
import { getConversation } from "@/lib/conversations/store";
import {
  conversationDirectory,
  downloadAsset,
  readAsset,
  saveAsset,
} from "@/lib/conversations/assets";

const paramsSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{24}$/),
  message: z.coerce.number().int().min(0).max(1999),
  index: z.coerce.number().int().min(0).max(99),
});
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string; message: string; index: string }> },
) {
  const admission = await requestIdentity();
  if (!admission?.profile || !admission.capability)
    return new Response("Not signed in.", { status: 401 });
  const { profile, capability } = admission;
  try {
    const { id, message, index } = paramsSchema.parse(await context.params);
    const asset = withProfileFiles(
      sharedAccess().identity,
      capability,
      () =>
        getConversation(profile.username, id)?.messages[message]?.assets?.[
          index
        ],
    );
    if (!asset) return new Response("Attachment not found.", { status: 404 });
    let saved = withProfileFiles(sharedAccess().identity, capability, () =>
      readAsset(
        conversationDirectory(profile.username, id),
        message,
        index,
        asset,
      ),
    );
    if (!saved) {
      const downloaded = await downloadAsset(asset);
      saved = withProfileFiles(sharedAccess().identity, capability, () => {
        const current = getConversation(profile.username, id)?.messages[message]
          ?.assets?.[index];
        if (!current || JSON.stringify(current) !== JSON.stringify(asset))
          throw new Error(
            "This attachment changed while downloading. Retry loading it.",
          );
        saveAsset(
          profile.username,
          id,
          message,
          index,
          asset,
          downloaded.bytes,
          downloaded.mime,
        );
        return readAsset(
          conversationDirectory(profile.username, id),
          message,
          index,
          asset,
        );
      });
    }
    if (!saved) throw new Error("Attachment could not be saved.");
    const download =
      new URL(request.url).searchParams.get("download") === "true" ||
      asset.kind === "file";
    return new Response(new Uint8Array(saved.bytes), {
      headers: {
        "Content-Type": saved.mime,
        "Content-Disposition": `${download ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(asset.name).replace(/'/g, "%27")}`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
      },
    });
  } catch (error) {
    if (isAccessError(error)) return accessFailure(error);
    return Response.json(
      { error: error instanceof Error ? error.message : "Attachment failed." },
      { status: error instanceof z.ZodError ? 400 : 422 },
    );
  }
}
