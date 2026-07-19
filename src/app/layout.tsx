import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
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
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable}`}
      suppressHydrationWarning
    >
      <head>
        <script
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
