/**
 * Plugin-side tool modules. Each handler answers the request types it owns and
 * returns null for everything else; the first non-null answer wins.
 *
 * To add a module: write `src/main/<module>.ts` exporting
 * `handle<Module>Request(request): Promise<Response | null>`, then add it to
 * MODULE_HANDLERS below. Shared helpers (str, num, need, requireEditor, walk,
 * hexToRgba, toHex, …) are exported from ./features.
 */
import { handleFeatureRequest, type Request, type Response } from "./features";

const MODULE_HANDLERS: Array<(request: Request) => Promise<Response | null>> = [
  handleFeatureRequest,
];

export const handleModuleRequest = async (request: Request): Promise<Response | null> => {
  for (const handle of MODULE_HANDLERS) {
    const response = await handle(request);
    if (response) return response;
  }
  return null;
};
