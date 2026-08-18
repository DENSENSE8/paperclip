import { build } from "esbuild";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

await build({
  entryPoints: [resolve(__dirname, "../src/ui/index.tsx")],
  outdir: resolve(__dirname, "../dist/ui"),
  bundle: true,
  format: "esm",
  platform: "browser",
  jsx: "automatic",
  external: ["react", "react-dom"],
  sourcemap: true,
  minify: false,
});

console.log("Linear Sync UI built");
