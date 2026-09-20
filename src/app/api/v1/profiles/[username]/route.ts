import { z } from "zod";
import {
  ACCESS_COOKIE,
  accessFailure,
  accessHandler,
  requestIdentity,
  sharedAccess,
} from "@/lib/auth/access";
import { ProfileOperations } from "@/lib/auth/profile-operations";
import { toPublicProfile, updateProfileAvatar } from "@/lib/auth/users";
import { sessionCookieOptions } from "@/lib/auth/session";
import { ANIMAL_AVATARS } from "@/lib/auth/avatars";
import { readBoundedJsonOrNull } from "@/lib/bounded-request";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
interface Params {
  params: Promise<{ username: string }>;
}

async function checkOrigin(request: Request): Promise<Response> {
  const headers = new Headers(request.headers);
  if (request.method === "DELETE")
    headers.set("content-type", "application/json");
  return accessHandler()(
    new Request(request.url, { method: "POST", headers, body: "{}" }),
    "check-origin",
  );
}

export async function GET(
  request: Request,
  { params }: Params,
): Promise<Response> {
  request.signal.throwIfAborted();
  try {
    const identity = await requestIdentity();
    if (!identity)
      return Response.json({ error: "Not signed in." }, { status: 401 });
    const status = await new ProfileOperations(
      sharedAccess().identity,
    ).deletionStatus(identity.token, (await params).username);
    return Response.json(status, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return accessFailure(error);
  }
}

export async function PATCH(
  request: Request,
  { params }: Params,
): Promise<Response> {
  const origin = await checkOrigin(request);
  if (!origin.ok) return origin;
  try {
    const identity = await requestIdentity();
    if (!identity)
      return Response.json({ error: "Not signed in." }, { status: 401 });
    const input = z
      .object({
        avatarSlug: z.enum(
          ANIMAL_AVATARS.map((avatar) => avatar.slug) as [string, ...string[]],
        ),
      })
      .safeParse(await readBoundedJsonOrNull(request));
    if (!input.success)
      return Response.json(
        { error: "Choose a valid avatar." },
        { status: 400 },
      );
    const profile = await updateProfileAvatar(
      (await params).username,
      input.data.avatarSlug,
      identity.token,
    );
    return Response.json({
      profile: toPublicProfile(profile, identity.principal?.role === "owner"),
    });
  } catch (error) {
    return accessFailure(error);
  }
}

export async function DELETE(
  request: Request,
  { params }: Params,
): Promise<Response> {
  const origin = await checkOrigin(request);
  if (!origin.ok) return origin;
  try {
    const identity = await requestIdentity();
    if (!identity)
      return Response.json({ error: "Not signed in." }, { status: 401 });
    const { username } = await params;
    const input = z
      .object({ confirmation: z.string() })
      .safeParse(await readBoundedJsonOrNull(request));
    if (!input.success || input.data.confirmation !== username)
      return Response.json(
        { error: `Type ${username} to confirm complete deletion.` },
        { status: 400 },
      );
    await new ProfileOperations(sharedAccess().identity).remove(
      identity.token,
      username,
    );
    const response = NextResponse.json(
      { ok: true, erasure: "pending" },
      { status: 202 },
    );
    if (identity.profile?.username === username) {
      await sharedAccess().access.logout(identity.token);
      response.cookies.set(ACCESS_COOKIE, "", {
        ...sessionCookieOptions(),
        maxAge: 0,
      });
    }
    return response;
  } catch (error) {
    return accessFailure(error);
  }
}
