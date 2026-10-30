import { z } from "zod";
import { requestIdentity } from "@/lib/auth/access";
import { siteIconSite } from "@/lib/chat/layout/site-icon";
import {
  loadSiteIcon,
  SiteIconBusyError,
} from "@/lib/conversations/icons/site-icon";

const input = z
  .object({
    url: z
      .string()
      .url()
      .max(2048)
      .refine((value) => siteIconSite(value)?.origin === value),
  })
  .strict();
const headers = {
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "default-src 'none'; sandbox",
};

export async function GET(request: Request): Promise<Response> {
  const identity = await requestIdentity();
  if (!identity?.profile || !identity.capability)
    return Response.json({ error: "Not signed in." }, { status: 401, headers });
  try {
    const { url } = input.parse(
      Object.fromEntries(new URL(request.url).searchParams),
    );
    const signal = AbortSignal.any([
      request.signal,
      AbortSignal.timeout(15_000),
    ]);
    const icon = await loadSiteIcon(url, signal);
    return new Response(new Uint8Array(icon.bytes), {
      headers: {
        ...headers,
        "Content-Type": icon.mime,
        "Content-Disposition": "inline",
      },
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Site icon failed." },
      {
        status:
          error instanceof z.ZodError
            ? 400
            : error instanceof SiteIconBusyError
              ? 429
              : 422,
        headers,
      },
    );
  }
}
