import fs from "node:fs";
import path from "node:path";
import { activeProfile } from "@/lib/auth/session";
import { getConversation } from "@/lib/conversations/store";
import { usersRoot } from "@/lib/data-dir";

type Context = { params: Promise<{ id: string; imageName: string }> };

const mediaTypes: Record<string, string> = {
  gif: "image/gif",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

export async function GET(request: Request, { params }: Context) {
  void request;
  const profile = await activeProfile();
  if (!profile) return new Response("Not signed in.", { status: 401 });
  const { id, imageName } = await params;
  if (!/^[a-f0-9]{24}$/.test(id) || !getConversation(profile.username, id))
    return new Response("Not found.", { status: 404 });
  if (!/^[a-f0-9]{24}\.(gif|jpe?g|png|webp)$/.test(imageName))
    return new Response("Not found.", { status: 404 });
  const file = path.join(
    usersRoot(),
    profile.username,
    "conversations",
    id,
    "attachments",
    imageName,
  );
  if (!fs.existsSync(file)) return new Response("Not found.", { status: 404 });
  const extension = path.extname(imageName).slice(1).toLowerCase();
  return new Response(fs.readFileSync(file), {
    headers: {
      "Content-Type": mediaTypes[extension] ?? "application/octet-stream",
      "Cache-Control": "private, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
