import { z } from "zod";
import { ANIMAL_AVATARS } from "@/lib/auth/avatars";
import { createProfile, toPublicProfile } from "@/lib/auth/users";
import {
  ACCESS_COOKIE,
  accessFailure,
  accessHandler,
  requestIdentity,
  sharedAccess,
} from "@/lib/auth/access";
import { readBoundedJsonOrNull } from "@/lib/bounded-request";
import { erasureWorkerStatus } from "@/lib/auth/platform/erasure-worker";

export async function GET(): Promise<Response> {
  try {
    const identity = await requestIdentity();
    if (!identity)
      return Response.json(
        {
          owner: false,
          profiles: [],
          instancePassword: true,
          gated: true,
        },
        { headers: { "Cache-Control": "private, no-store" } },
      );
    const state = await sharedAccess().identity.read();
    const authenticated = sharedAccess().access.sessionFromState(
      state.access,
      identity.token,
    );
    const owner = authenticated.principal?.role === "owner";
    const worker = owner ? erasureWorkerStatus() : undefined;
    const visible =
      owner || state.access.mode === "household"
        ? state.profiles
        : state.profiles.filter(
            (profile) => profile.username === identity.profile?.username,
          );
    return Response.json(
      {
        owner,
        ...(worker
          ? {
              erasures: {
                workerRunning: worker.running,
                profiles: state.erasures.map((marker) => ({
                  ...marker,
                  status:
                    worker.diagnostics.find(
                      (entry) =>
                        entry.username === marker.username &&
                        entry.generation === marker.generation,
                    )?.status ?? "pending",
                })),
              },
            }
          : {}),
        profiles: visible.map((profile) =>
          toPublicProfile(
            profile,
            owner &&
              state.access.principals.some(
                (principal) =>
                  principal.role === "owner" &&
                  state.bindings[principal.id] === profile.username,
              ),
          ),
        ),
        instancePassword: true,
      },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return accessFailure(error);
  }
}

const createSchema = z.object({
  displayName: z.string().min(2).max(40),
  avatarSlug: z
    .enum(ANIMAL_AVATARS.map((a) => a.slug) as [string, ...string[]])
    .optional(),
  password: z.string().max(200).optional(),
});

export async function POST(request: Request): Promise<Response> {
  const handler = accessHandler();
  const headers = new Headers(request.headers);
  const check = await handler(
    new Request(request.url, { method: "POST", headers, body: "{}" }),
    "check-origin",
  );
  if (!check.ok) return check;
  const input = createSchema.safeParse(await readBoundedJsonOrNull(request));
  if (!input.success)
    return Response.json({ error: "Invalid profile." }, { status: 400 });
  let admission: Response | undefined;
  let token: string | undefined;
  try {
    let identity = await requestIdentity();
    if (!identity) {
      admission = await handler(
        new Request(request.url, {
          method: "POST",
          headers,
          body: JSON.stringify({ password: input.data.password ?? "" }),
        }),
        "household",
      );
      if (!admission.ok) return admission;
      const cookie = admission.headers.get("set-cookie")?.split(";")[0];
      if (!cookie?.startsWith(ACCESS_COOKIE + "="))
        throw new Error("Access handler did not issue a session cookie");
      token = decodeURIComponent(cookie.slice(ACCESS_COOKIE.length + 1));
      identity = await requestIdentity(token);
    }
    if (!identity)
      return Response.json({ error: "Not signed in." }, { status: 401 });
    const profile = await createProfile(
      input.data.displayName,
      input.data.avatarSlug,
      identity.token,
    );
    const response = Response.json(
      { profile: toPublicProfile(profile) },
      { status: 201 },
    );
    const cookie = admission?.headers.get("set-cookie");
    if (cookie) response.headers.set("set-cookie", cookie);
    return response;
  } catch (error) {
    if (token) await sharedAccess().access.logout(token);
    return accessFailure(error);
  }
}
