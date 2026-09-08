import { activeProfile } from "@/lib/auth/session";
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
  const profile = await activeProfile();
  if (!profile)
    return Response.json({ error: "Not signed in." }, { status: 401 });
  const { id } = await params;
  const conversation = getConversation(profile.username, id);
  return conversation
    ? Response.json(
        { conversation },
        { headers: { "Cache-Control": "no-store" } },
      )
    : Response.json({ error: "Conversation not found." }, { status: 404 });
}
export async function PATCH(request: Request, { params }: Context) {
  const profile = await activeProfile();
  if (!profile)
    return Response.json({ error: "Not signed in." }, { status: 401 });
  try {
    return Response.json({
      conversation: updateConversation(
        profile.username,
        (await params).id,
        metadataSchema.parse(await readBoundedJson(request)),
      ),
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Update failed." },
      { status: 400 },
    );
  }
}
export async function DELETE(request: Request, { params }: Context) {
  void request;
  const profile = await activeProfile();
  if (!profile)
    return Response.json({ error: "Not signed in." }, { status: 401 });
  try {
    deleteConversation(profile.username, (await params).id);
    return Response.json({ ok: true });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Delete failed." },
      { status: 409 },
    );
  }
}
