import { globSync } from "node:fs";
import { build } from "esbuild";

export const clientEntryPoints = () =>
  globSync("src/web/client/*.ts")
    .filter((entry) => !entry.endsWith(".test.ts"))
    .toSorted();

if (import.meta.main) {
  await build({
    entryPoints: clientEntryPoints(),
    bundle: true,
    minify: true,
    format: "esm",
    outdir: "public/client",
  });
}
