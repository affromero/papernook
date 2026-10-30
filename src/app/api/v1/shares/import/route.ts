import { z } from "zod";
import { requestIdentity, sharedAccess } from "@/lib/auth/access";
import { withProfileFiles } from "@/lib/auth/profile-capability";
import { readBoundedJsonOrNull } from "@/lib/bounded-request";
import {
  bundleSchema,
  SharingError,
  sharingFailure,
  slugSchema,
} from "@/lib/sharing/schema";
import { exchange, parseShareUrl } from "@/lib/sharing/transport";
import { importBundle } from "@/lib/sharing/bundle";
import { artifactVersions } from "@/lib/sharing/artifacts/snapshot";
import {
  newSecret,
  participantId,
  saveConnection,
} from "@/lib/sharing/storage";

const bodySchema = z
  .object({
    url: z.string().max(4500),
    topic: slugSchema,
    mode: z.enum(["fork", "collaborate"]),
    acknowledgePublicAnnotations: z.boolean().default(false),
  })
  .strict();

export async function POST(request: Request) {
  try {
    const admission = await requestIdentity();
    if (!admission?.profile || !admission.capability)
      throw new SharingError("Not signed in.", 401);
    const parsed = bodySchema.safeParse(await readBoundedJsonOrNull(request));
    if (!parsed.success) throw new SharingError("Invalid import request.");
    const body = parsed.data;
    if (body.mode === "collaborate" && !body.acknowledgePublicAnnotations)
      throw new SharingError(
        "Confirm the visibility of collaborative annotations before requesting access.",
      );
    parseShareUrl(body.url);
    const bundle = bundleSchema.parse(
      await exchange(body.url, { action: "bundle" }),
    );
    if (body.mode === "collaborate" && bundle.mode !== "collaborate")
      throw new SharingError("This link permits independent copies only.", 403);
    const token = newSecret();
    if (body.mode === "collaborate")
      await exchange(
        body.url,
        { action: "request", name: admission.profile.displayName },
        token,
        () =>
          withProfileFiles(
            sharedAccess().identity,
            admission.capability!,
            () => undefined,
          ),
      );
    const paper = await importBundle(
      bundle,
      body.topic,
      admission.capability,
      body.mode === "collaborate",
    );
    if (body.mode === "collaborate") {
      const mirror = await artifactVersions(body.topic, paper.slug);
      saveConnection(
        body.topic,
        paper.slug,
        admission.capability,
        {
          version: 1,
          url: body.url,
          token,
          participantId: participantId(token),
          username: admission.capability.username,
          generation: admission.capability.generation,
          mirrorEtag: bundle.etag,
          artifacts: { source: null, mirror },
        },
        true,
      );
    }
    return Response.json(
      {
        href: `/paper/${body.topic}/${paper.slug}`,
        participantId:
          body.mode === "collaborate" ? participantId(token) : null,
      },
      { status: 201, headers: { "cache-control": "private, no-store" } },
    );
  } catch (error) {
    return sharingFailure(error);
  }
}
