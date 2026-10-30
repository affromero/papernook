import crypto from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { activeProfile } from "@/lib/auth/session";
import { readBoundedJson } from "@/lib/bounded-request";
import { getPaper } from "@/lib/library/papers";
import { readExerciseRecords } from "@/lib/library/exercises";
import {
  exerciseMarkdownSchema,
  exerciseOperationSchema,
} from "@/lib/library/exercises/schema";
import {
  connectedExercises,
  createConnectedExercise,
} from "@/lib/sharing/artifacts/gateway";
import { localArtifactAuthority } from "@/lib/sharing/artifacts/local";
import {
  createSourceExercise,
  recoverSourceExercises,
} from "@/lib/sharing/artifacts/source";
import { sharingFailure } from "@/lib/sharing/schema";
import { PdfBusyError, PdfConflictError } from "@/lib/library/pdf/file";
import { FilesystemBusyError } from "@/lib/filesystem-lock";

export const dynamic = "force-dynamic";
interface Params {
  params: Promise<{ topic: string; slug: string }>;
}
const saveSchema = z
  .object({
    markdown: exerciseMarkdownSchema,
    operationId: exerciseOperationSchema.optional(),
  })
  .strict();

function failure(error: unknown): Response {
  if (error instanceof PdfConflictError)
    return NextResponse.json({ error: error.message }, { status: 412 });
  if (error instanceof PdfBusyError || error instanceof FilesystemBusyError)
    return NextResponse.json({ error: error.message }, { status: 409 });
  return sharingFailure(error);
}

export async function GET(_request: NextRequest, { params }: Params) {
  if (!(await activeProfile()))
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  const { topic, slug } = await params;
  try {
    if (!getPaper(topic, slug))
      return NextResponse.json({ error: "Unknown paper." }, { status: 404 });
    const connected = await connectedExercises(topic, slug);
    if (connected)
      return NextResponse.json(
        {
          exercises: connected.exercises.map((record) => record.name),
          records: connected.exercises,
        },
        { headers: { "cache-control": "private, no-store" } },
      );
    const authority = await localArtifactAuthority();
    await recoverSourceExercises(topic, slug, authority.commit);
    const records = readExerciseRecords(topic, slug).records;
    return NextResponse.json(
      { exercises: records.map((record) => record.name), records },
      { headers: { "cache-control": "private, no-store" } },
    );
  } catch (error) {
    return failure(error);
  }
}

export async function POST(request: NextRequest, { params }: Params) {
  if (!(await activeProfile()))
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  const { topic, slug } = await params;
  try {
    const body = saveSchema.safeParse(
      await readBoundedJson(request, 600 * 1024, AbortSignal.timeout(30_000)),
    );
    if (!body.success)
      return NextResponse.json({ error: "Invalid exercise." }, { status: 400 });
    const operationId = body.data.operationId ?? crypto.randomUUID();
    const connected = await createConnectedExercise(
      topic,
      slug,
      body.data.markdown,
      operationId,
    );
    if (connected) return NextResponse.json(connected, { status: 201 });
    const authority = await localArtifactAuthority();
    await recoverSourceExercises(topic, slug, authority.commit);
    const result = await createSourceExercise(
      topic,
      slug,
      body.data.markdown,
      operationId,
      authority.actor,
      authority.commit,
    );
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    return failure(error);
  }
}
