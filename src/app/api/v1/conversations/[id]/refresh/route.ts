import { z } from "zod";
import {
  requestIdentity,
  sharedAccess,
  accessFailure,
} from "@/lib/auth/access";
import { withProfileFiles } from "@/lib/auth/profile-capability";
import { isAccessError } from "thesidedoor-core/access";
import {
  getConversation,
  lockConversation,
  refreshConversationContent,
} from "@/lib/conversations/store";
import { importShare } from "@/lib/conversations/import";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  void request;
  const admission = await requestIdentity();
  if (!admission?.profile || !admission.capability)
    return new Response("Not signed in.", { status: 401 });
  const { profile, capability } = admission;
  let release: (() => void) | undefined;
  try {
    const id = z
      .string()
      .regex(/^[a-f0-9]{24}$/)
      .parse((await context.params).id);
    const source = withProfileFiles(sharedAccess().identity, capability, () => {
      const source = getConversation(profile.username, id);
      if (source) release = lockConversation(profile.username, id);
      return source;
    });
    if (!source?.sourceUrl)
      return Response.json(
        { error: "Shared source not found." },
        { status: 404 },
      );
    const fresh = await importShare(source.sourceUrl);
    const conversation = withProfileFiles(
      sharedAccess().identity,
      capability,
      () => refreshConversationContent(profile.username, id, fresh),
    );
    return Response.json(
      { conversation },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    if (isAccessError(error)) return accessFailure(error);
    return Response.json(
      { error: error instanceof Error ? error.message : "Refresh failed." },
      { status: 400 },
    );
  } finally {
    release?.();
  }
}
