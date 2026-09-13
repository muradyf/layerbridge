import React from "react";
import { createRoot } from "react-dom/client";
import inter from "@fontsource-variable/inter/files/inter-latin-wght-normal.woff2?inline";
import App from "./App";
import "./index.css";

// Inter (OFL-1.1) is bundled into the plugin rather than fetched from Google
// Fonts: the manifest then needs no network access beyond localhost.
const face = new FontFace("Inter", `url(${inter}) format("woff2")`, { weight: "100 900", style: "normal" });
face
  .load()
  .then((loaded) => (document.fonts as unknown as { add(font: FontFace): void }).add(loaded))
  .catch(() => undefined);

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(<App />);
}
