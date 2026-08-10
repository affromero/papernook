import { NextResponse, type NextRequest } from "next/server";
import { profileForCaptureToken } from "@/lib/auth/users";
import { recordFailure, retryAfterMs } from "@/lib/auth/rate-limit";
import { clientIp } from "@/lib/auth/request-security";
import { readBoundedForm, RequestBodyError } from "@/lib/bounded-request";
import { getPaper } from "@/lib/library/papers";
import { isValidSlug } from "@/lib/library/slug";
import {
  clearCaptureJob,
  readCaptureJob,
  removeCaptureJobDir,
} from "@/lib/capture/jobs";
import { confirmationPage, errorPage, pendingPage } from "../pages";

/**
 * Poll target for the /add pending page. Token-authed POST (credentials
 * never enter URLs) that reads the on-disk capture marker: analyzing keeps
 * the pending page, failed renders the recorded reason, done renders the
 * confirmation form for the finished inbox paper and retires the marker.
 */

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest): Promise<NextResponse> {
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

  const ipKey = `ip:${clientIp(request)}`;
  if (retryAfterMs(ipKey) > 0) {
    return html(errorPage("Too many attempts. Try again later."), 429);
  }
  const profile = profileForCaptureToken(token);
  if (!profile) {
    recordFailure(ipKey);
    return html(
      errorPage(
        "Invalid capture token. Re-copy your bookmarklet or Shortcut from Settings.",
      ),
      401,
    );
  }
  if (!isValidSlug(slug)) {
    return html(errorPage("Invalid capture reference."), 400);
  }

  const job = readCaptureJob(slug);
  if (!job || job.addedBy !== profile.username) {
    return html(
      errorPage(
        "This capture is no longer pending — it may already be in your papernook inbox.",
      ),
      404,
    );
  }
  if (job.state === "analyzing") {
    const nonce = request.headers.get("x-nonce") ?? "";
    return html(pendingPage(slug, token, nonce), 202);
  }
  if (job.state === "failed") {
    return html(errorPage(job.error ?? "Capture failed."), 422);
  }
  const paper = job.finalSlug ? getPaper(null, job.finalSlug) : null;
  if (!paper || paper.meta.addedBy !== profile.username) {
    return html(
      errorPage(
        "This capture is no longer pending — it may already be in your papernook inbox.",
      ),
      404,
    );
  }
  // Viewed once: the confirmation form carries everything the accept
  // endpoint needs, so the provisional handle has done its job.
  clearCaptureJob(slug);
  removeCaptureJobDir(slug);
  return html(confirmationPage(paper, token), 200);
}

function html(body: string, status: number): NextResponse {
  return new NextResponse(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-robots-tag": "noindex, nofollow",
    },
  });
}
