import { execFileSync } from "node:child_process";
import { copyFileSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { build, type Plugin } from "esbuild";

const seaFuse = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";
const glueRead = "require('fs').readFileSync(wasmPath)";
const assetRead = 'require("node:sea").getAsset("alass_wasm_bg.wasm")';

const wasmFromSEA: Plugin = {
  name: "wasm-from-sea",
  setup: (plugin) => {
    plugin.onLoad({ filter: /alass_wasm\.js$/ }, ({ path }) => {
      const glue = readFileSync(path, "utf8");

      if (!glue.includes(glueRead)) {
        throw new Error(`${path} no longer reads the WASM with ${glueRead}`);
      }

      return { contents: glue.replace(glueRead, assetRead), loader: "js" };
    });
  },
};

const { node, out } = parseArgs({
  options: {
    node: { type: "string", default: process.execPath },
    out: {
      type: "string",
      default: process.platform === "win32" ? "dist/subsontime.exe" : "dist/subsontime",
    },
  },
}).values;

const macOS = process.platform === "darwin";

await build({
  stdin: {
    contents: 'import { runFromShell } from "./src/cli/main.ts";\n\nrunFromShell();',
    resolveDir: ".",
    loader: "ts",
  },
  bundle: true,
  platform: "node",
  target: "node24",
  format: "cjs",
  outfile: "dist/subsontime.cjs",
  plugins: [wasmFromSEA],
});

execFileSync(process.execPath, ["--experimental-sea-config", "sea-config.json"]);
copyFileSync(node, out);

if (macOS) {
  execFileSync("codesign", ["--remove-signature", out]);
}

execFileSync(process.execPath, [
  "node_modules/postject/dist/cli.js",
  out,
  "NODE_SEA_BLOB",
  "dist/subsontime.blob",
  "--sentinel-fuse",
  seaFuse,
  ...(macOS ? ["--macho-segment-name", "NODE_SEA"] : []),
]);

if (macOS) {
  execFileSync("codesign", ["--sign", "-", out]);
}
