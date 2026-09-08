import { conversationSnapshot, snapshotResponse } from "@/lib/offline/server";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  void request;
  const { id } = await context.params;
  return snapshotResponse((owner) => conversationSnapshot(owner, id));
}
