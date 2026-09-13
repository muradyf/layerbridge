/**
 * Playwright for compare_to_image (url) and import_url. Playwright is optional
 * and never a dependency: it is loaded on first use, and a missing install
 * answers with how to add one.
 */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const PLAYWRIGHT_MISSING =
  "This needs Playwright, which is optional and not installed. In the server folder run `bun add playwright` (or `npm i playwright`), then `npx playwright install chromium`. To use an install that already exists elsewhere, set FIGMA_BRIDGE_PLAYWRIGHT to its playwright or playwright-core folder.";

export interface Viewport {
  width: number;
  height: number;
}

const LOCAL_HOSTS = /^(localhost|.+\.localhost|127(\.\d{1,3}){3}|::1|0\.0\.0\.0)$/i;

/** localhost and file: only, unless FIGMA_BRIDGE_ALLOW_REMOTE_URLS=1. */
export const checkUrl = (raw: string): URL => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Not a URL: ${raw}`);
  }
  if (url.protocol === "file:") return url;
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`Only http, https and file URLs are supported, not ${url.protocol}`);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!LOCAL_HOSTS.test(host) && process.env.FIGMA_BRIDGE_ALLOW_REMOTE_URLS !== "1") {
    throw new Error(`${url.host} is not on this machine. Only localhost and file URLs are opened unless the server runs with FIGMA_BRIDGE_ALLOW_REMOTE_URLS=1.`);
  }
  return url;
};

type Chromium = {
  launch(options?: Record<string, unknown>): Promise<Browser>;
};
type Browser = {
  newContext(options?: Record<string, unknown>): Promise<{ newPage(): Promise<Page> }>;
  close(): Promise<void>;
};
export type Page = {
  goto(url: string, options?: Record<string, unknown>): Promise<unknown>;
  waitForLoadState(state: string, options?: Record<string, unknown>): Promise<void>;
  screenshot(options?: Record<string, unknown>): Promise<Buffer>;
  locator(selector: string): { first(): { screenshot(options?: Record<string, unknown>): Promise<Buffer>; count(): Promise<number> }; count(): Promise<number> };
  addScriptTag(options: { path?: string; content?: string }): Promise<unknown>;
  evaluate<T>(fn: (arg: string | null) => T | Promise<T>, arg: string | null): Promise<T>;
};

const isNotFound = (err: unknown) => {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND";
};

export const loadChromium = async (): Promise<Chromium> => {
  const override = process.env.FIGMA_BRIDGE_PLAYWRIGHT;
  const specifiers: string[] = [];
  if (override) {
    try {
      specifiers.push(pathToFileURL(createRequire(import.meta.url).resolve(path.resolve(override))).href);
    } catch {
      throw new Error(`FIGMA_BRIDGE_PLAYWRIGHT is set to ${override}, which is not a playwright or playwright-core folder`);
    }
  }
  specifiers.push("playwright", "playwright-core");
  for (const specifier of specifiers) {
    try {
      const mod = await import(specifier);
      const chromium = (mod.chromium ?? mod.default?.chromium) as Chromium | undefined;
      if (chromium) return chromium;
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
  }
  throw new Error(PLAYWRIGHT_MISSING);
};

export const withPage = async <T>(
  url: URL,
  viewport: Viewport,
  deviceScaleFactor: number,
  run: (page: Page) => Promise<T>
): Promise<T> => {
  const chromium = await loadChromium();
  let browser: Browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/Executable doesn't exist|browserType\.launch/i.test(message)) {
      throw new Error(`Playwright is installed but its Chromium is not: run \`npx playwright install chromium\`. (${message.split("\n")[0]})`);
    }
    throw err;
  }
  try {
    const context = await browser.newContext({ viewport, deviceScaleFactor });
    const page = await context.newPage();
    await page.goto(url.href, { waitUntil: "load", timeout: 60_000 });
    // Late fonts and images; a page that keeps polling never goes idle, so cap it.
    await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => undefined);
    return await run(page);
  } finally {
    await browser.close();
  }
};

export const screenshotUrl = (url: URL, viewport: Viewport, scale: number, selector?: string) =>
  withPage(url, viewport, scale, async (page) => {
    if (!selector) return page.screenshot({ type: "png" });
    const target = page.locator(selector);
    if ((await target.count()) === 0) throw new Error(`No element matches ${selector} on ${url.href}`);
    return target.first().screenshot({ type: "png" });
  });

/** Built by `bun run build` from browser/html-figma-entry.js. */
export const htmlFigmaBundlePath = () => fileURLToPath(new URL("./vendor/html-figma.browser.js", import.meta.url));

export const serializeUrl = (url: URL, viewport: Viewport, selector?: string) => {
  const bundle = htmlFigmaBundlePath();
  if (!existsSync(bundle)) throw new Error(`The html-figma browser bundle is missing (${bundle}); rebuild the server with \`bun run build\`.`);
  return withPage(url, viewport, 1, async (page) => {
    await page.addScriptTag({ path: bundle });
    return page.evaluate(
      (sel) => (window as unknown as { __figmaBridgeHtmlToFigma: (s: string | null) => Promise<unknown> }).__figmaBridgeHtmlToFigma(sel),
      selector ?? null
    ) as Promise<Record<string, unknown> | null>;
  });
};
