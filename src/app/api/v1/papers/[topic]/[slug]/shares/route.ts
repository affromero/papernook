import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { readBoundedJsonOrNull } from "@/lib/bounded-request";
import {
  requestIdentity,
  sharedAccess,
  accessFailure,
} from "@/lib/auth/access";
import { withProfileFiles } from "@/lib/auth/profile-capability";
import { getPaper } from "@/lib/library/papers";
import { readConnection } from "@/lib/sharing/storage";
import { snapshotArtifacts } from "@/lib/sharing/artifacts/snapshot";
import { sharingFailure } from "@/lib/sharing/schema";
import {
  createShare,
  listShares,
  ShareError,
  type PaperShare,
} from "@/lib/library/shares";

export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ topic: string; slug: string }>;
}

const createSchema = z
  .object({
    chatIds: z.array(z.string().regex(/^[a-f0-9]{16}$/)).max(20),
    mode: z.enum(["view", "fork", "collaborate"]).default("view"),
    acknowledgePublicAnnotations: z.boolean().default(false),
    includeArtifacts: z.boolean().default(false),
  })
  .strict();

function toPublicSummary(share: PaperShare) {
  return {
    id: share.id,
    href: `/share/${share.topic}/${share.slug}/${share.id}`,
    createdAt: share.createdAt,
    mode: share.mode,
    revoked: share.revoked,
    includeArtifacts: share.includeArtifacts,
    conversations: share.conversations.map((conversation) => ({
      id: conversation.header.id,
      title: conversation.header.title,
    })),
  };
}

export async function GET(_request: NextRequest, { params }: Params) {
  const admission = await requestIdentity();
  const profile = admission?.profile;
  const capability = admission?.capability;
  if (!profile || !capability) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }
  const { topic, slug } = await params;
  if (!getPaper(topic, slug)) {
    return NextResponse.json({ error: "Unknown paper." }, { status: 404 });
  }
  try {
    return withProfileFiles(sharedAccess().identity, capability, () =>
      NextResponse.json(
        {
          shares: listShares(topic, slug, profile.username).map(
            toPublicSummary,
          ),
        },
        { headers: { "Cache-Control": "no-store" } },
      ),
    );
  } catch (error) {
    return accessFailure(error);
  }
}

export async function POST(request: NextRequest, { params }: Params) {
  const admission = await requestIdentity();
  const profile = admission?.profile;
  const capability = admission?.capability;
  if (!profile || !capability) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }
  const { topic, slug } = await params;
  if (!getPaper(topic, slug)) {
    return NextResponse.json({ error: "Unknown paper." }, { status: 404 });
  }
  const body = createSchema.safeParse(await readBoundedJsonOrNull(request));
  if (!body.success) {
    return NextResponse.json(
      { error: "Invalid conversations." },
      { status: 400 },
    );
  }
  try {
    if (readConnection(topic, slug))
      return NextResponse.json(
        {
          error:
            "Create sharing links on the original owner's instance. Use an independent fork to share your own copy.",
        },
        { status: 403 },
      );
    if (
      body.data.mode === "collaborate" &&
      !body.data.acknowledgePublicAnnotations
    )
      return NextResponse.json(
        {
          error:
            "Confirm that collaborative annotations will also appear through existing reading links.",
        },
        { status: 400 },
      );
    const snapshot =
      body.data.includeArtifacts || body.data.mode === "collaborate"
        ? await snapshotArtifacts(topic, slug)
        : undefined;
    const artifacts = body.data.includeArtifacts ? snapshot : undefined;
    const share = withProfileFiles(sharedAccess().identity, capability, () =>
      createShare(
        topic,
        slug,
        capability,
        body.data.chatIds,
        body.data.mode,
        artifacts,
      ),
    );
    return NextResponse.json(
      { share: toPublicSummary(share) },
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof ShareError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return sharingFailure(error);
  }
}
