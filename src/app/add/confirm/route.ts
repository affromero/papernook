import { NextResponse, type NextRequest } from "next/server";
import {
  captureIdentity,
  withProfileFiles,
} from "@/lib/auth/profile-capability";
import { isAccessError } from "thesidedoor-core/access";
import { FileLockBusyError } from "thesidedoor-core/storage";
import { sharedAccess } from "@/lib/auth/access";
import {
  acceptInboxCapture,
  CaptureOwnershipError,
} from "@/lib/library/papers";
import { slugify, isValidSlug } from "@/lib/library/slug";
import { rebuildIndex } from "@/lib/library/index-db";
import { lockoutKey } from "@/lib/auth/request-security";
import { recordFailure, retryAfterMs } from "@/lib/auth/rate-limit";
import { readBoundedForm, RequestBodyError } from "@/lib/bounded-request";
import { acceptedPage, errorPage } from "../pages";

/** Accept an inbox capture into the chosen topic folder. */

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const html = (body: string, status: number) =>
    new NextResponse(body, {
      status,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
        "x-robots-tag": "noindex, nofollow",
      },
    });

  let form: URLSearchParams;
  try {
    form = await readBoundedForm(request, 32 * 1024);
  } catch (err) {
    return html(
      errorPage("Request body too large."),
      err instanceof RequestBodyError ? err.status : 400,
    );
  }
  const token = form.get("token") ?? "";
  const slug = form.get("slug") ?? "";
  const chosen = form.get("topic") ?? "";
  const newTopic = form.get("newtopic") ?? "";

  // Same unauthenticated-token surface as /add: throttle guesses per client.
  const ipKey = lockoutKey(request, "confirm-ip");
  if (ipKey && retryAfterMs(ipKey) > 0) {
    return html(errorPage("Too many attempts. Try again later."), 429);
  }
  const admission = await captureIdentity(sharedAccess().identity, token);
  const profile = admission?.profile;
  if (!profile || !admission) {
    if (ipKey) recordFailure(ipKey);
    return html(errorPage("Invalid capture token."), 401);
  }
  const topic = slugify(newTopic.trim() || chosen.trim());
  if (!isValidSlug(slug) || !isValidSlug(topic)) {
    return html(errorPage("Invalid folder or paper name."), 400);
  }
  try {
    withProfileFiles(sharedAccess().identity, admission.capability, () => {
      acceptInboxCapture(slug, topic, profile.username);
      rebuildIndex();
    });
    return html(acceptedPage(slug, topic), 200);
  } catch (err) {
    if (isAccessError(err))
      return html(errorPage("Invalid capture token."), 401);
    if (err instanceof CaptureOwnershipError) {
      return html(errorPage("No pending capture exists."), 404);
    }
    return html(
      errorPage(err instanceof Error ? err.message : "Accept failed."),
      err instanceof FileLockBusyError ? 503 : 500,
    );
  }
}
