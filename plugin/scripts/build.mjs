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

// code.js last: the UI it opens is already in place when Figma picks it up.
const publish = () => {
  mkdirSync(dist, { recursive: true });
  const files = readdirSync(next).sort((a, b) => (a === "code.js") - (b === "code.js"));
  for (const file of files) renameSync(path.join(next, file), path.join(dist, file));
};

const configs = ["vite.config.ts", "vite.config.main.ts"].map((file) => path.join(root, file));

rmSync(next, { recursive: true, force: true });

if (process.argv.includes("--watch")) {
  // Same rule for `bun run dev`: each rebuild lands in .dist-next and is
  // renamed across when it finishes. Nothing empties the folder between
  // rebuilds, or one watcher could delete the other's unpublished file.
  mkdirSync(next, { recursive: true });
  for (const configFile of configs) {
    const watcher = await build({ configFile, build: { outDir: next, emptyOutDir: false, watch: {} } });
    watcher.on("event", (event) => {
      if (event.code === "BUNDLE_END") publish();
      if (event.code === "ERROR") console.error(event.error);
    });
  }
} else {
  try {
    await build({ configFile: configs[0], build: { outDir: next, emptyOutDir: true } });
    await build({ configFile: configs[1], build: { outDir: next, emptyOutDir: false } });
    publish();
  } finally {
    rmSync(next, { recursive: true, force: true });
  }
}
