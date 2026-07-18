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
  description: "Your papers, annotated and understood — self-hosted.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable}`}>
      <body>
        <PwaSetup />
        {children}
      </body>
    </html>
  );
}
