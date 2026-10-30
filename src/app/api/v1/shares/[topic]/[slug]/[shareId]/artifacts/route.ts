import { z } from "zod";
import { getShare, withShareFiles } from "@/lib/library/shares";
import { readPublishedArtifacts } from "@/lib/sharing/artifacts/publication";
import { validatePortableCanvas } from "@/lib/sharing/artifacts/canvas";
import { canvasMediaType, portableAssetNameSchema } from "@/lib/canvas/media";
import { withSharingResponse } from "@/lib/sharing/storage";
import { sharingFailure, SharingError } from "@/lib/sharing/schema";

export const dynamic = "force-dynamic";
interface Params {
  params: Promise<{ topic: string; slug: string; shareId: string }>;
}
const querySchema = z.union([
  z.object({}).strict(),
  z.object({ asset: portableAssetNameSchema }).strict(),
  z.object({ pdf: z.literal("1") }).strict(),
]);
const headers = {
  "cache-control": "private, no-store",
  "referrer-policy": "no-referrer",
  "x-robots-tag": "noindex, nofollow",
  "x-content-type-options": "nosniff",
  "content-security-policy":
    "default-src 'none'; sandbox; frame-ancestors 'none'",
};

export async function GET(request: Request, { params }: Params) {
  try {
    const { topic, slug, shareId } = await params;
    const share = getShare(topic, slug, shareId);
    if (!share?.includeArtifacts)
      throw new SharingError("Unknown shared snapshot.", 404);
    const query = querySchema.parse(
      Object.fromEntries(new URL(request.url).searchParams),
    );
    return await withSharingResponse(async () => {
      const snapshot = readPublishedArtifacts(share);
      return withShareFiles(share, () => {
        if ("pdf" in query) {
          if (!snapshot.exercisePdf)
            throw new SharingError("No exercise PDF was shared.", 404);
          return new Response(Buffer.from(snapshot.exercisePdf.pdf, "base64"), {
            headers: {
              ...headers,
              "content-type": "application/pdf",
              etag: snapshot.exercisePdf.etag,
            },
          });
        }
        if ("asset" in query) {
          const asset = snapshot.assets[query.asset];
          if (!asset) throw new SharingError("Unknown shared media.", 404);
          return new Response(Buffer.from(asset, "base64"), {
            headers: {
              ...headers,
              "content-type": canvasMediaType(query.asset),
            },
          });
        }
        const canvas = validatePortableCanvas(snapshot.canvas, snapshot.assets);
        if (canvas)
          for (const record of Object.values(canvas.store)) {
            if (
              record.typeName === "asset" &&
              record.type !== "bookmark" &&
              record.props.src
            )
              record.props.src = `/api/v1/shares/${topic}/${slug}/${shareId}/artifacts?asset=${encodeURIComponent(record.props.src.slice(15))}`;
          }
        return Response.json(
          {
            document: canvas,
            exercises: snapshot.exercises,
            hasPdf: snapshot.exercisePdf !== null,
          },
          { headers },
        );
      });
    });
  } catch (error) {
    return sharingFailure(error);
  }
}
