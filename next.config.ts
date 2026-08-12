import type { NextConfig } from "next";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MAX_PDF_BYTES } from "./src/lib/pdf-limits";

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
            // The scene code running here is AI-authored and therefore
            // steerable by a malicious paper. The opaque origin stops it
            // reading the app, but says nothing about what it may SEND, so
            // every outbound channel is closed: no fetch/XHR/WebSocket
            // (connect-src), no remote image beacon (img-src), no form post.
            // 'unsafe-inline' is unavoidable — the scene arrives as inline
            // module text — and is harmless once nothing can leave.
            key: "Content-Security-Policy",
            value: [
              "default-src 'none'",
              "script-src 'self' 'unsafe-inline'",
              "style-src 'unsafe-inline'",
              "img-src 'self' data: blob:",
              "font-src data:",
              "connect-src 'none'",
              "worker-src 'none'",
              "form-action 'none'",
              "base-uri 'none'",
              "frame-ancestors 'self'",
            ].join("; "),
          },
          {
            key: "Cache-Control",
            value: "public, max-age=86400, stale-while-revalidate=604800",
          },
        ],
      },
    ];
  },
  turbopack: { root: projectRoot },
  experimental: {
    // Annotation saves PUT the whole PDF through src/proxy.ts; the 10MB
    // default silently truncates larger bodies instead of failing them.
    proxyClientMaxBodySize: MAX_PDF_BYTES,
  },
};

export default nextConfig;
