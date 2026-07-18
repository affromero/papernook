import { NextResponse, type NextRequest } from "next/server";
import { profileForCaptureToken } from "@/lib/auth/users";
import { acceptFromInbox } from "@/lib/library/papers";
import { slugify, isValidSlug } from "@/lib/library/slug";
import { rebuildIndex } from "@/lib/library/index-db";
import { acceptedPage, errorPage } from "../pages";

/** Accept an inbox capture into the chosen topic folder. */

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const form = await request.formData().catch(() => null);
  const token = (form?.get("token") as string | null) ?? "";
  const slug = (form?.get("slug") as string | null) ?? "";
  const chosen = (form?.get("topic") as string | null) ?? "";
  const newTopic = (form?.get("newtopic") as string | null) ?? "";

  const html = (body: string, status: number) =>
    new NextResponse(body, {
      status,
      headers: { "content-type": "text/html; charset=utf-8" },
    });

  if (!profileForCaptureToken(token)) {
    return html(errorPage("Invalid capture token."), 401);
  }
  const topic = slugify(newTopic.trim() || chosen.trim());
  if (!isValidSlug(slug) || !isValidSlug(topic)) {
    return html(errorPage("Invalid folder or paper name."), 400);
  }
  try {
    acceptFromInbox(slug, topic);
    rebuildIndex();
    return html(acceptedPage(slug, topic), 200);
  } catch (err) {
    return html(
      errorPage(err instanceof Error ? err.message : "Accept failed."),
      500,
    );
  }
}
