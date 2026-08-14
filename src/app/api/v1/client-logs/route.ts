import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { consumeRequestLimit } from "@/lib/auth/rate-limit";
import { activeProfile } from "@/lib/auth/session";
import { readBoundedJson, RequestBodyError } from "@/lib/bounded-request";

export const dynamic = "force-dynamic";

const location = z.number().int().min(0).max(10_000_000);
const diagnosticSchema = z
  .object({
    protocol: z.literal(1),
    type: z.literal("papernook-three-diagnostic"),
    kind: z.enum([
      "bootstrap-decode-failed",
      "module-evaluation-failed",
      "resource-load-failed",
      "unhandled-rejection",
      "console-error",
      "webgl-unavailable",
      "webgl-context-lost",
      "canvas-missing",
    ]),
    line: location.optional(),
    column: location.optional(),
    resource: z
      .enum([
        "sandbox",
        "three-module",
        "three-core",
        "three-addon",
        "three-runtime",
        "other-vendor",
      ])
      .optional(),
  })
  .strict();

const NO_STORE = { "Cache-Control": "no-store" };

export async function POST(request: NextRequest): Promise<NextResponse> {
  const profile = await activeProfile();
  if (!profile) {
    return NextResponse.json(
      { error: "Not signed in." },
      { status: 401, headers: NO_STORE },
    );
  }

  let raw: unknown;
  try {
    raw = await readBoundedJson(request, 4 * 1024);
  } catch (error) {
    const status = error instanceof RequestBodyError ? error.status : 400;
    return NextResponse.json(
      {
        error:
          status === 413 ? "Request body too large." : "Invalid diagnostic.",
      },
      { status, headers: NO_STORE },
    );
  }
  const parsed = diagnosticSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid diagnostic." },
      { status: 400, headers: NO_STORE },
    );
  }

  const wait = consumeRequestLimit(
    `three-diagnostic:${profile.username}`,
    20,
    60_000,
  );
  if (wait > 0) {
    return NextResponse.json(
      { error: "Too many diagnostics." },
      {
        status: 429,
        headers: {
          ...NO_STORE,
          "Retry-After": String(Math.ceil(wait / 1000)),
        },
      },
    );
  }

  const userAgent = (request.headers.get("user-agent") ?? "unknown").slice(
    0,
    500,
  );
  console.error(
    JSON.stringify({
      event: "papernook-three-diagnostic",
      username: profile.username,
      userAgent,
      ...parsed.data,
    }),
  );
  return new NextResponse(null, { status: 204, headers: NO_STORE });
}
