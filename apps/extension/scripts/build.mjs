import { cp, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";

const rootDir = resolve(import.meta.dirname, "..");
const srcDir = resolve(rootDir, "src");
const distDir = resolve(rootDir, "dist");

await rm(distDir, { recursive: true, force: true });
await mkdir(distDir, { recursive: true });

await build({
  bundle: true,
  entryPoints: {
    background: resolve(srcDir, "background.ts"),
    content: resolve(srcDir, "content.ts"),
    popup: resolve(srcDir, "popup.ts")
  },
  format: "iife",
  logLevel: "info",
  outdir: distDir,
  platform: "browser",
  sourcemap: true,
  target: ["chrome114", "firefox115"]
});

await cp(resolve(rootDir, "manifest.json"), resolve(distDir, "manifest.json"));
await cp(resolve(rootDir, "popup.html"), resolve(distDir, "popup.html"));

console.log(`Built extension into ${distDir}`);
