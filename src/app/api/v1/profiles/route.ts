import { NextResponse } from "next/server";
import { z } from "zod";
import { ANIMAL_AVATARS } from "@/lib/auth/avatars";
import {
  createProfile,
  listProfiles,
  toPublicProfile,
  ProfileError,
} from "@/lib/auth/users";

export async function GET(): Promise<NextResponse> {
  return NextResponse.json({ profiles: listProfiles().map(toPublicProfile) });
}

const createSchema = z.object({
  displayName: z.string().min(2).max(40),
  avatarSlug: z
    .enum(ANIMAL_AVATARS.map((a) => a.slug) as [string, ...string[]])
    .optional(),
});

export async function POST(request: Request): Promise<NextResponse> {
  const body = createSchema.safeParse(await request.json().catch(() => null));
  if (!body.success) {
    return NextResponse.json({ error: "Invalid profile." }, { status: 400 });
  }
  try {
    const profile = createProfile(body.data.displayName, body.data.avatarSlug);
    return NextResponse.json(
      { profile: toPublicProfile(profile) },
      { status: 201 },
    );
  } catch (err) {
    if (err instanceof ProfileError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    throw err;
  }
}
