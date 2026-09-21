import {
  requestIdentity,
  sharedAccess,
  accessFailure,
} from "@/lib/auth/access";
import { withProfileFiles } from "@/lib/auth/profile-capability";
import { isAccessError } from "thesidedoor-core/access";
import { readBoundedJson } from "@/lib/bounded-request";
import {
  deleteConversation,
  getConversation,
  metadataSchema,
  updateConversation,
} from "@/lib/conversations/store";
type Context = { params: Promise<{ id: string }> };
export async function GET(request: Request, { params }: Context) {
  void request;
  const admission = await requestIdentity();
  const profile = admission?.profile;
  const capability = admission?.capability;
  if (!profile || !capability)
    return Response.json({ error: "Not signed in." }, { status: 401 });
  const { id } = await params;
  let conversation;
  try {
    conversation = withProfileFiles(sharedAccess().identity, capability, () =>
      getConversation(profile.username, id),
    );
  } catch (error) {
    return accessFailure(error);
  }
  return conversation
    ? Response.json(
        { conversation },
        { headers: { "Cache-Control": "no-store" } },
      )
    : Response.json({ error: "Conversation not found." }, { status: 404 });
}
export async function PATCH(request: Request, { params }: Context) {
  const admission = await requestIdentity();
  const profile = admission?.profile;
  const capability = admission?.capability;
  if (!profile || !capability)
    return Response.json({ error: "Not signed in." }, { status: 401 });
  try {
    const { id } = await params;
    const metadata = metadataSchema.parse(await readBoundedJson(request));
    return Response.json({
      conversation: withProfileFiles(sharedAccess().identity, capability, () =>
        updateConversation(profile.username, id, metadata),
      ),
    });
  } catch (error) {
    if (isAccessError(error)) return accessFailure(error);
    return Response.json(
      { error: error instanceof Error ? error.message : "Update failed." },
      { status: 400 },
    );
  }
}
export async function DELETE(request: Request, { params }: Context) {
  void request;
  const admission = await requestIdentity();
  const profile = admission?.profile;
  const capability = admission?.capability;
  if (!profile || !capability)
    return Response.json({ error: "Not signed in." }, { status: 401 });
  try {
    const { id } = await params;
    withProfileFiles(sharedAccess().identity, capability, () =>
      deleteConversation(profile.username, id),
    );
    return Response.json({ ok: true });
  } catch (error) {
    if (isAccessError(error)) return accessFailure(error);
    return Response.json(
      { error: error instanceof Error ? error.message : "Delete failed." },
      { status: 409 },
    );
  }
}
