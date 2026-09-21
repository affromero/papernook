import { z } from "zod";
import {
  requestIdentity,
  sharedAccess,
  accessFailure,
} from "@/lib/auth/access";
import { withProfileFiles } from "@/lib/auth/profile-capability";
import { isAccessError } from "thesidedoor-core/access";
import { readBoundedJson, RequestBodyError } from "@/lib/bounded-request";
import {
  createConversation,
  listConversations,
  MAX_TRANSCRIPT_BYTES,
} from "@/lib/conversations/store";
import { importShare, importTranscript } from "@/lib/conversations/import";
const inputSchema = z
  .object({
    url: z.string().max(2000).optional(),
    content: z.string().max(MAX_TRANSCRIPT_BYTES).optional(),
    format: z.enum(["json", "markdown"]).default("markdown"),
    title: z.string().trim().min(1).max(200).optional(),
    topic: z.string().trim().min(1).max(80).default("Uncategorized"),
    tags: z.array(z.string().trim().min(1).max(60)).max(30).default([]),
  })
  .refine(
    (value) => Boolean(value.url) !== Boolean(value.content),
    "Provide either a share URL or a transcript.",
  );
export async function GET() {
  const admission = await requestIdentity();
  const profile = admission?.profile;
  const capability = admission?.capability;
  if (!profile || !capability)
    return Response.json({ error: "Not signed in." }, { status: 401 });
  try {
    return withProfileFiles(sharedAccess().identity, capability, () =>
      Response.json(
        { conversations: listConversations(profile.username) },
        { headers: { "Cache-Control": "no-store" } },
      ),
    );
  } catch (error) {
    return accessFailure(error);
  }
}
export async function POST(request: Request) {
  const admission = await requestIdentity();
  const profile = admission?.profile;
  const capability = admission?.capability;
  if (!profile || !capability)
    return Response.json({ error: "Not signed in." }, { status: 401 });
  try {
    const input = inputSchema.parse(
      await readBoundedJson(request, MAX_TRANSCRIPT_BYTES + 64 * 1024),
    );
    const source = input.url
      ? await importShare(input.url)
      : importTranscript(input.content!, input.format);
    const conversation = withProfileFiles(
      sharedAccess().identity,
      capability,
      () =>
        createConversation(profile.username, {
          ...source,
          title: input.title ?? source.title,
          topic: input.topic,
          tags: input.tags,
        }),
    );
    return Response.json({ conversation }, { status: 201 });
  } catch (error) {
    if (isAccessError(error)) return accessFailure(error);
    return Response.json(
      { error: error instanceof Error ? error.message : "Import failed." },
      { status: error instanceof RequestBodyError ? error.status : 400 },
    );
  }
}
