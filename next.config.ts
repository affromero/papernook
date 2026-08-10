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
      {
        // The chat ThreeSandbox iframe (sandbox="allow-scripts") has an
        // opaque origin, and ES-module fetches are CORS-gated — vendored
        // libs must answer with ACAO. SAMEORIGIN overrides the global
        // DENY so the app may frame three-sandbox.html; /vendor/ is also
        // excluded from the auth/CSP proxy (public library code only).
        source: "/vendor/:path*",
        headers: [
          { key: "Access-Control-Allow-Origin", value: "*" },
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          {
            key: "Cache-Control",
            value: "public, max-age=86400, stale-while-revalidate=604800",
          },
        ],
      },
    ];
  },
  turbopack: { root: projectRoot },
};

export default nextConfig;
