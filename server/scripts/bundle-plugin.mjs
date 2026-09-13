#!/usr/bin/env node
// Copies the built Figma plugin into server/plugin/ so the npm package carries
// it: `npx <package> setup` then points Figma's "Import plugin from manifest"
// at a copy of it. Run after `bun run build` in plugin/.
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const server = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(server, "..", "plugin");
const target = path.join(server, "plugin");

for (const required of ["manifest.json", "dist/code.js", "dist/index.html"]) {
  if (!existsSync(path.join(source, required))) {
    console.error(`bundle-plugin: plugin/${required} is missing — run \`bun run build\` in plugin/ first`);
    process.exit(1);
  }
}

rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
cpSync(path.join(source, "manifest.json"), path.join(target, "manifest.json"));
// FigJam and Slides need a second manifest: Figma won't allow figjam and dev together.
cpSync(path.join(source, "manifest.boards.json"), path.join(target, "manifest.boards.json"));
cpSync(path.join(source, "dist"), path.join(target, "dist"), { recursive: true });
// html-figma's own MIT notice travels with the code vendored from it.
cpSync(path.join(source, "src", "html-figma", "NOTICE.md"), path.join(target, "NOTICE-html-figma.md"));
console.log(`bundle-plugin: copied plugin into ${path.relative(process.cwd(), target) || "."}`);
