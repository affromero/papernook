import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { headers } from "next/headers";
import { PwaSetup } from "@/components/pwa/PwaSetup";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  manifest: "/manifest.webmanifest",
  title: "papernook",
  description: "Your papers, annotated and understood, on your own server.",
  icons: {
    icon: [{ url: "/icon.svg?v=papernook-1", type: "image/svg+xml" }],
    shortcut: "/icon.svg?v=papernook-1",
    apple: "/apple-icon.png?v=papernook-1",
  },
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable}`}
      suppressHydrationWarning
    >
      <head>
        <script
          nonce={nonce}
          suppressHydrationWarning
          dangerouslySetInnerHTML={{
            __html:
              '(function(){try{var t=localStorage.getItem("papernook:theme");var v=t==="light"||t==="dark"?t:(matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light");document.documentElement.dataset.theme=v;document.documentElement.style.colorScheme=v}catch(e){}})()',
          }}
        />
      </head>
      <body>
        <PwaSetup />
        {children}
      </body>
    </html>
  );
}
