import { accessHandler } from "@/lib/auth/access";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ action: string }> };

async function handle(request: Request, context: Context): Promise<Response> {
  return accessHandler()(request, (await context.params).action);
}

export { handle as GET, handle as POST };
