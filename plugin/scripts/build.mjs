// Builds the plugin into .dist-next/ and only then renames each file into
// dist/. Figma reloads a running development plugin when its files change;
// building straight into dist/ emptied it first, so for about a second there
// was no dist/code.js, a reload in that window failed with "Unable to load
// code: ENOENT" and the plugin stayed dead until it was run again by hand.
// A rename replaces the file in one step, so code.js is never missing.
import { mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const next = path.join(root, ".dist-next");
const dist = path.join(root, "dist");

rmSync(next, { recursive: true, force: true });
try {
  await build({ configFile: path.join(root, "vite.config.ts"), build: { outDir: next, emptyOutDir: true } });
  await build({ configFile: path.join(root, "vite.config.main.ts"), build: { outDir: next, emptyOutDir: false } });
  mkdirSync(dist, { recursive: true });
  // code.js last: the UI it opens is already in place when Figma picks it up.
  const files = readdirSync(next).sort((a, b) => (a === "code.js") - (b === "code.js"));
  for (const file of files) renameSync(path.join(next, file), path.join(dist, file));
} finally {
  rmSync(next, { recursive: true, force: true });
}
