import { z } from "zod";
import { accessHandler, requestIdentity } from "@/lib/auth/access";
import { toPublicProfile } from "@/lib/auth/users";
import { readBoundedJsonOrNull } from "@/lib/bounded-request";

function actionRequest(
  request: Request,
  body: unknown,
  cookie?: string,
): Request {
  const headers = new Headers(request.headers);
  if (request.method !== "POST")
    headers.set("content-type", "application/json");
  if (cookie) headers.set("cookie", cookie);
  return new Request(request.url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: request.signal,
  });
}

export async function GET(): Promise<Response> {
  const identity = await requestIdentity();
  return Response.json(
    {
      profile: identity?.profile
        ? toPublicProfile(identity.profile, identity.isAdmin)
        : null,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(request: Request): Promise<Response> {
  const input = z
    .object({ username: z.string().min(2).max(31) })
    .strict()
    .safeParse(await readBoundedJsonOrNull(request));
  if (!input.success)
    return Response.json({ error: "Invalid login." }, { status: 400 });
  const handler = accessHandler();
  const currentIdentity = await requestIdentity();
  if (!currentIdentity)
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  if (currentIdentity?.principal) {
    const authorized = await handler(
      actionRequest(request, {}),
      "authorize-session",
    );
    if (!authorized.ok) return authorized;
    if (currentIdentity.profile?.username !== input.data.username)
      return Response.json({ error: "Forbidden." }, { status: 403 });
    return Response.json(
      {
        profile: toPublicProfile(
          currentIdentity.profile,
          currentIdentity.isAdmin,
        ),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
  const selected = await handler(
    actionRequest(request, { id: input.data.username }),
    "select-profile",
  );
  if (!selected.ok) return selected;
  const identity = await requestIdentity();
  return Response.json(
    {
      profile: identity?.profile
        ? toPublicProfile(identity.profile, identity.isAdmin)
        : null,
    },
    { headers: selected.headers },
  );
}

export async function DELETE(request: Request): Promise<Response> {
  return accessHandler()(actionRequest(request, {}), "logout");
}
