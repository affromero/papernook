import { build } from "esbuild";
await build({
  entryPoints: ["src/lib/sharing/process.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  outfile: "build/sharing-worker.cjs",
});
