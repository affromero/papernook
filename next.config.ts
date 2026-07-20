import type { NextConfig } from "next";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.dirname(fileURLToPath(import.meta.url));
const privateTraceExcludes = [
  "./data/**/*",
  "./.env*",
  "./.git/**/*",
  "./tests/**/*",
  "./docs/**/*",
  "./src/**/*",
  "./AGENTS.md",
  "./CLAUDE.md",
];

const nextConfig: NextConfig = {
  // Native module: must stay external so webpack never bundles the .node binary.
  serverExternalPackages: ["better-sqlite3"],
  // Self-contained server bundle for the Docker image.
  output: "standalone",
  outputFileTracingRoot: projectRoot,
  outputFileTracingExcludes: {
    "/*": privateTraceExcludes,
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          {
            key: "Cross-Origin-Opener-Policy",
            value: "same-origin",
          },
          {
            key: "Permissions-Policy",
            value:
              "camera=(), geolocation=(), microphone=(), payment=(), usb=()",
          },
          { key: "Referrer-Policy", value: "no-referrer" },
          {
            key: "Strict-Transport-Security",
            value: "max-age=31536000; includeSubDomains",
          },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
        ],
      },
    ];
  },
  turbopack: { root: projectRoot },
};

export default nextConfig;
