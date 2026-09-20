import fs from "node:fs";
import path from "node:path";
import {
  requestIdentity,
  sharedAccess,
  accessFailure,
} from "@/lib/auth/access";
import { withProfileFiles } from "@/lib/auth/profile-capability";
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
  const admission = await requestIdentity();
  const profile = admission?.profile;
  const capability = admission?.capability;
  if (!profile || !capability)
    return new Response("Not signed in.", { status: 401 });
  const { id, imageName } = await params;
  try {
    return withProfileFiles(sharedAccess().identity, capability, () => {
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
      if (!fs.existsSync(file))
        return new Response("Not found.", { status: 404 });
      const extension = path.extname(imageName).slice(1).toLowerCase();
      return new Response(fs.readFileSync(file), {
        headers: {
          "Content-Type": mediaTypes[extension] ?? "application/octet-stream",
          "Cache-Control": "private, no-store",
          "X-Content-Type-Options": "nosniff",
        },
      });
    });
  } catch (error) {
    return accessFailure(error);
  }
}
