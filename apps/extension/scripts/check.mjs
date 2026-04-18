import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const rootDir = resolve(import.meta.dirname, "..");
const distDir = resolve(rootDir, "dist");
const requiredFiles = [
  "manifest.json",
  "background.js",
  "content.js",
  "popup.html",
  "popup.js"
];

for (const file of requiredFiles) {
  const filePath = resolve(distDir, file);
  await readFile(filePath);
}

const manifestPath = resolve(distDir, "manifest.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

if (manifest.manifest_version !== 3) {
  throw new Error("manifest_version must be 3");
}

if (!manifest.background?.service_worker) {
  throw new Error("background.service_worker is required");
}

if (!Array.isArray(manifest.content_scripts) || manifest.content_scripts.length === 0) {
  throw new Error("content_scripts must contain at least one entry");
}

if (manifest.content_scripts.some((entry) => entry.js.includes("shared.js"))) {
  throw new Error("shared.js should not be referenced after bundling");
}

console.log("Extension manifest check passed.");
