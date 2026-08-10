import { notFound, redirect } from "next/navigation";
import { headers } from "next/headers";
import { activeProfile } from "@/lib/auth/session";
import { getPaper } from "@/lib/library/papers";
import { getProvider, hasConfiguredProvider } from "@/lib/agent/registry";
import { ChatPanel } from "@/components/chat/ChatPanel";
import { ReadingWorkspace } from "@/components/chat/ReadingWorkspace";
import { PaperHeader } from "@/components/paper/PaperHeader";
import { CanvasClient } from "./CanvasClient";
import {
  CanvasConfigError,
  configuredCanvasLicense,
  tldrawLicenseRequired,
} from "@/lib/canvas/config";
import styles from "../paper.module.css";

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
  const headerStore = await headers();
  const protocol = headerStore.get("x-forwarded-proto") ?? "http";
  const hostname = headerStore.get("host") ?? "localhost";
  const aiAvailable = hasConfiguredProvider();
  const visionAvailable = aiAvailable && getProvider().capabilities.vision;
  let licenseKey: string | null = null;
  let licenseError: string | null = null;
  try {
    licenseKey = configuredCanvasLicense().licenseKey;
  } catch (error) {
    licenseError =
      error instanceof CanvasConfigError
        ? error.message
        : "The canvas configuration could not be loaded.";
  }

  return (
    <main className={styles.root}>
      <ReadingWorkspace
        mainLabel="Canvas"
        header={
          <PaperHeader
            topic={topic}
            slug={slug}
            meta={paper.meta}
            view="canvas"
          />
        }
        main={
          <CanvasClient
            topic={topic}
            slug={slug}
            title={paper.meta.title}
            licenseKey={licenseKey}
            licenseRequired={tldrawLicenseRequired(protocol, hostname)}
            licenseError={licenseError}
            visionAvailable={visionAvailable}
          />
        }
        chat={
          <div className={styles.chat}>
            {paper.summary && <p className={styles.summary}>{paper.summary}</p>}
            <ChatPanel
              topic={topic}
              slug={slug}
              aiAvailable={aiAvailable}
              visionAvailable={visionAvailable}
            />
          </div>
        }
      />
    </main>
  );
}
