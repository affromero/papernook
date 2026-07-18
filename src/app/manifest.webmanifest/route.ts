import { NextResponse } from "next/server";
import { buildManifest } from "thesidedoor/pwa";

/** PWA manifest so papernook installs to the iPad/phone home screen. */

export const dynamic = "force-static";

export function GET(): NextResponse {
  return NextResponse.json(
    buildManifest({
      name: "papernook",
      shortName: "papernook",
      description: "Your papers, annotated and understood, on your own server.",
      themeColor: "#3f4fb0",
      backgroundColor: "#f5f4f0",
      icons: [
        { src: "/avatars/capybara.png", sizes: "512x512", type: "image/png" },
      ],
    }),
    { headers: { "content-type": "application/manifest+json" } },
  );
}
