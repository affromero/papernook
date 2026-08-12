import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getProvider, configuredProviderId } from "@/lib/agent/registry";
import { activeProfile } from "@/lib/auth/session";
import { isAdmin } from "@/lib/auth/users";
import { readBoundedJsonOrNull } from "@/lib/bounded-request";

export const dynamic = "force-dynamic";

const schema = z.object({});

function json(body: object, status = 200): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

// One connection test at a time for the whole instance. Each spawns a CLI
// process or a paid API call for up to 45s, and the button is a single
// click, so there is no legitimate reason to run them concurrently — while
// 120 parallel requests would fit inside the global rate limit.
// ponytail: a plain boolean, not a queue; tests are a manual admin action.
let testInFlight = false;

export async function POST(request: NextRequest): Promise<NextResponse> {
  const profile = await activeProfile();
  if (!profile) return json({ error: "Not signed in." }, 401);
  if (!isAdmin(profile)) return json({ error: "Admin only." }, 403);
  const body = schema.safeParse(await readBoundedJsonOrNull(request));
  if (!body.success) return json({ error: "Invalid request." }, 400);
  if (testInFlight) {
    return json({ error: "A model test is already running." }, 429);
  }
  testInFlight = true;

  const startedAt = performance.now();
  try {
    const provider = configuredProviderId();
    const reply = await getProvider(provider).execute({
      system:
        "This is a connection test. Follow the user's instruction exactly and do not use tools.",
      prompt: "Reply with exactly: Papernook model test passed",
      allowWeb: false,
      timeoutMs: 45_000,
      maxOutputTokens: 512,
      maxOutputChars: 512,
    });
    return json({
      provider,
      reply: reply.trim().slice(0, 500),
      elapsedMs: Math.round(performance.now() - startedAt),
    });
  } catch (error) {
    console.error(
      "AI model test failed:",
      error instanceof Error ? error.message : "unknown error",
    );
    return json({ error: "The selected model did not answer." }, 503);
  } finally {
    testInFlight = false;
  }
}
