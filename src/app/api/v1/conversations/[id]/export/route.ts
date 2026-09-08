import { z } from "zod";
import { activeProfile } from "@/lib/auth/session";
import {
  getConversation,
  listConversationChats,
} from "@/lib/conversations/store";
import {
  documentSlug,
  privateHeaders,
  renderMessages,
} from "@/lib/offline/server";
import { escapeHtml, MAX_STUDY_BYTES, studyHtml } from "@/lib/offline/render";

export const dynamic = "force-dynamic";
const querySchema = z.object({
  format: z.enum(["html", "markdown", "json"]).default("html"),
  chats: z.enum(["true", "false"]).default("true"),
});

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const profile = await activeProfile();
  if (!profile)
    return Response.json(
      { error: "Unauthorized" },
      { status: 401, headers: privateHeaders },
    );
  try {
    const id = documentSlug.parse((await context.params).id);
    const query = querySchema.parse(
      Object.fromEntries(new URL(request.url).searchParams),
    );
    const source = getConversation(profile.username, id);
    if (!source)
      return Response.json(
        { error: "Document not found" },
        { status: 404, headers: privateHeaders },
      );
    const chats =
      query.chats === "true"
        ? listConversationChats(profile.username, id).filter(
            (chat) => chat.header.username === profile.username,
          )
        : [];
    let body: string;
    let mime: string;
    let extension: string;
    if (query.format === "json") {
      body = JSON.stringify({ ...source, chats }, null, 2);
      mime = "application/json";
      extension = "json";
    } else if (query.format === "markdown") {
      body = `# ${source.title}\n\n${source.messages.map((message) => `## ${message.role}\n\n${message.content}`).join("\n\n")}${chats.map((chat) => `\n\n# Follow-up: ${chat.header.title}\n\n${chat.messages.map((message) => `## ${message.role}\n\n${message.content}${(message.images ?? []).map((image) => `\n\nAttachment unavailable: ${image}`).join("")}`).join("\n\n")}`).join("")}`;
      mime = "text/markdown";
      extension = "md";
    } else {
      body = studyHtml(
        source.title,
        `${renderMessages(source.messages)}${chats.map((chat) => `<section><h2>Follow-up: ${escapeHtml(chat.header.title)}</h2>${renderMessages(chat.messages)}</section>`).join("")}`,
      );
      mime = "text/html";
      extension = "html";
    }
    if (Buffer.byteLength(body) > MAX_STUDY_BYTES)
      throw new Error("Export exceeds the 32 MB limit.");
    return new Response(body, {
      headers: {
        ...privateHeaders,
        "Content-Type": `${mime}; charset=utf-8`,
        "Content-Disposition": `attachment; filename="conversation-${id}.${extension}"`,
      },
    });
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof z.ZodError
            ? "Invalid export request"
            : error instanceof Error
              ? error.message
              : "Export failed",
      },
      {
        status: error instanceof z.ZodError ? 400 : 422,
        headers: privateHeaders,
      },
    );
  }
}
