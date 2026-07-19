import { notFound, redirect } from "next/navigation";
import { activeProfile } from "@/lib/auth/session";
import { getPaper } from "@/lib/library/papers";

export const dynamic = "force-dynamic";

interface CanvasPageProps {
  params: Promise<{ topic: string; slug: string }>;
}

export default async function CanvasPage({ params }: CanvasPageProps) {
  const profile = await activeProfile();
  if (!profile) redirect("/login");
  const { topic, slug } = await params;
  const paper = getPaper(topic, slug);
  if (!paper) notFound();
  redirect(`/paper/${topic}/${slug}`);
}
