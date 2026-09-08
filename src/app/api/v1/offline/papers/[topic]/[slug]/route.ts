import { paperSnapshot, snapshotResponse } from "@/lib/offline/server";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ topic: string; slug: string }> },
) {
  void request;
  const { topic, slug } = await context.params;
  return snapshotResponse((owner) => paperSnapshot(owner, topic, slug));
}
