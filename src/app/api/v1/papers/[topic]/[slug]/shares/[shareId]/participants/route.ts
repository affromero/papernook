import { z } from "zod";
import { requestIdentity } from "@/lib/auth/access";
import { readBoundedJsonOrNull } from "@/lib/bounded-request";
import {
  publicParticipant,
  readParticipants,
  requireCollaboration,
  setParticipant,
  withCollaboration,
} from "@/lib/sharing/storage";
import {
  idSchema,
  labelSchema,
  SharingError,
  sharingFailure,
} from "@/lib/sharing/schema";

type Params = {
  params: Promise<{ topic: string; slug: string; shareId: string }>;
};
const updateSchema = z
  .object({
    id: idSchema,
    status: z.enum(["approved", "revoked"]),
    name: labelSchema.optional(),
  })
  .strict();

async function owner(params: Params["params"]) {
  const admission = await requestIdentity();
  if (!admission?.capability) throw new SharingError("Not signed in.", 401);
  const { topic, slug, shareId } = await params;
  const share = requireCollaboration(topic, slug, shareId);
  if (
    share.ownerUsername !== admission.capability.username ||
    share.ownerGeneration !== admission.capability.generation
  )
    throw new SharingError(
      "Only the sharing owner can manage participants.",
      403,
    );
  return share;
}

export async function GET(_request: Request, { params }: Params) {
  try {
    const share = await owner(params);
    return await withCollaboration(share, async () =>
      Response.json(
        { participants: readParticipants(share).map(publicParticipant) },
        { headers: { "cache-control": "private, no-store" } },
      ),
    );
  } catch (error) {
    return sharingFailure(error);
  }
}
export async function PATCH(request: Request, { params }: Params) {
  try {
    const share = await owner(params);
    const body = updateSchema.safeParse(await readBoundedJsonOrNull(request));
    if (!body.success) throw new SharingError("Invalid participant update.");
    return await withCollaboration(share, async () => {
      setParticipant(share, body.data.id, body.data.status, body.data.name);
      return Response.json(
        { participants: readParticipants(share).map(publicParticipant) },
        { headers: { "cache-control": "private, no-store" } },
      );
    });
  } catch (error) {
    return sharingFailure(error);
  }
}
