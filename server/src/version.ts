/*
 * Derived from gethopp/figma-mcp-bridge (https://github.com/gethopp/figma-mcp-bridge), MIT License.
 * Copyright (c) 2026 GETHOPP LTD. Modifications Copyright (c) 2026 Murad Yousuf.
 * See LICENSE.md and NOTICE.md.
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version: string };

export const VERSION = pkg.version;
