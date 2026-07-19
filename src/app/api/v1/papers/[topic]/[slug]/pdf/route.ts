import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { activeProfile } from "@/lib/auth/session";
import {
  InvalidPdfError,
  PdfBusyError,
  PdfConflictError,
  PdfFileError,
  PdfTooLargeError,
  readVersionedPdf,
  replacePdf,
} from "@/lib/library/pdf/file";
import { isValidSlug } from "@/lib/library/slug";
import { MAX_PDF_BYTES } from "@/lib/pdf-limits";

export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ topic: string; slug: string }>;
}

const paramsSchema = z.object({
  topic: z.string().refine(isValidSlug),
  slug: z.string().refine(isValidSlug),
});

const saveHeadersSchema = z.object({
  ifMatch: z.string().regex(/^"[a-f0-9]{64}"$/),
  contentType: z
    .string()
    .transform((value) => value.split(";", 1)[0]?.trim().toLowerCase())
    .pipe(z.literal("application/pdf")),
  contentLength: z
    .string()
    .regex(/^\d+$/)
    .transform(Number)
    .pipe(z.number().int().nonnegative().max(MAX_PDF_BYTES))
    .nullable(),
});

async function readPdfBody(request: NextRequest): Promise<Uint8Array> {
  if (!request.body) throw new InvalidPdfError("The PDF body is empty.");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_PDF_BYTES) {
      await reader.cancel();
      throw new PdfTooLargeError("The saved PDF exceeds the 100 MB limit.");
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function GET(_req: NextRequest, { params }: Params) {
  const profile = await activeProfile();
  if (!profile)
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  const parsedParams = paramsSchema.safeParse(await params);
  if (!parsedParams.success) {
    return NextResponse.json({ error: "Invalid paper." }, { status: 400 });
  }
  const { topic, slug } = parsedParams.data;
  const pdf = await readVersionedPdf(topic, slug);
  if (!pdf)
    return NextResponse.json({ error: "Unknown paper." }, { status: 404 });
  return new NextResponse(new Uint8Array(pdf.bytes).buffer, {
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `inline; filename="${slug}.pdf"`,
      "cache-control": "private, no-store",
      etag: pdf.etag,
    },
  });
}

export async function PUT(request: NextRequest, { params }: Params) {
  const profile = await activeProfile();
  if (!profile) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }
  const parsedParams = paramsSchema.safeParse(await params);
  if (!parsedParams.success) {
    return NextResponse.json({ error: "Invalid paper." }, { status: 400 });
  }
  const headers = saveHeadersSchema.safeParse({
    ifMatch: request.headers.get("if-match"),
    contentType: request.headers.get("content-type"),
    contentLength: request.headers.get("content-length"),
  });
  if (!headers.success) {
    const declaredLength = request.headers.get("content-length");
    if (
      declaredLength &&
      /^\d+$/.test(declaredLength) &&
      Number(declaredLength) > MAX_PDF_BYTES
    ) {
      return NextResponse.json(
        { error: "The saved PDF exceeds the 100 MB limit." },
        { status: 413 },
      );
    }
    return NextResponse.json(
      {
        error:
          "Saving requires a PDF body and the version returned when it was opened.",
      },
      { status: 400 },
    );
  }

  try {
    const bytes = await readPdfBody(request);
    const { topic, slug } = parsedParams.data;
    const result = await replacePdf(topic, slug, headers.data.ifMatch, bytes);
    return NextResponse.json(result, {
      headers: {
        etag: result.etag,
        "cache-control": "private, no-store",
      },
    });
  } catch (error) {
    if (error instanceof PdfConflictError) {
      return NextResponse.json({ error: error.message }, { status: 412 });
    }
    if (error instanceof PdfBusyError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof PdfTooLargeError) {
      return NextResponse.json({ error: error.message }, { status: 413 });
    }
    if (error instanceof InvalidPdfError) {
      return NextResponse.json({ error: error.message }, { status: 422 });
    }
    if (error instanceof PdfFileError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    throw error;
  }
}
