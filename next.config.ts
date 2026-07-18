import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Native module: must stay external so webpack never bundles the .node binary.
  serverExternalPackages: ["better-sqlite3"],
  // Self-contained server bundle for the Docker image.
  output: "standalone",
};

export default nextConfig;
