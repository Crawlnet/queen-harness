// The tools layer: live crypto data for the harness's model as function-calling tools. Built from env;
// server-side only (its keys never reach a browser).

import type { CreateTools } from "@crawlnet/shared";
import { createToolsWith } from "./registry.ts";

export const createTools: CreateTools = (ctx) => createToolsWith(ctx);

export { createToolsWith, type Tools, type ToolsOptions } from "./registry.ts";
