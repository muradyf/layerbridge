/**
 * FigJam and Figma Slides tools. All run in the plugin, which refuses them in
 * any other editor; the enums mirror @figma/plugin-typings 1.130.
 */
import { z } from "zod";
import { confirm, fileKey, nodeId, type PluginToolDef } from "./common.js";

const SHAPE_TYPES = [
  "SQUARE", "ELLIPSE", "ROUNDED_RECTANGLE", "DIAMOND", "TRIANGLE_UP", "TRIANGLE_DOWN",
  "PARALLELOGRAM_RIGHT", "PARALLELOGRAM_LEFT", "ENG_DATABASE", "ENG_QUEUE", "ENG_FILE", "ENG_FOLDER",
  "TRAPEZOID", "PREDEFINED_PROCESS", "SHIELD", "DOCUMENT_SINGLE", "DOCUMENT_MULTIPLE", "MANUAL_INPUT",
  "HEXAGON", "CHEVRON", "PENTAGON", "OCTAGON", "STAR", "PLUS", "ARROW_LEFT", "ARROW_RIGHT",
  "SUMMING_JUNCTION", "OR", "SPEECH_BUBBLE", "INTERNAL_STORAGE",
] as const;

const CONNECTOR_CAPS = [
  "NONE", "ARROW_EQUILATERAL", "ARROW_LINES", "TRIANGLE_FILLED", "DIAMOND_FILLED", "CIRCLE_FILLED",
  "ERD_ZERO_OR_ONE", "ERD_EXACTLY_ONE", "ERD_ZERO_OR_MORE", "ERD_ONE_OR_MORE", "ERD_ONE", "ERD_MANY",
] as const;

const MAGNETS = ["AUTO", "TOP", "BOTTOM", "LEFT", "RIGHT", "CENTER", "NONE"] as const;

const CODE_LANGUAGES = [
  "TYPESCRIPT", "CPP", "RUBY", "CSS", "JAVASCRIPT", "HTML", "JSON", "GRAPHQL", "PYTHON", "GO", "SQL",
  "SWIFT", "KOTLIN", "RUST", "BASH", "PLAINTEXT", "DART",
] as const;

const TRANSITION_STYLES = [
  "NONE", "DISSOLVE", "SLIDE_FROM_LEFT", "SLIDE_FROM_RIGHT", "SLIDE_FROM_BOTTOM", "SLIDE_FROM_TOP",
  "PUSH_FROM_LEFT", "PUSH_FROM_RIGHT", "PUSH_FROM_BOTTOM", "PUSH_FROM_TOP", "MOVE_FROM_LEFT",
  "MOVE_FROM_RIGHT", "MOVE_FROM_TOP", "MOVE_FROM_BOTTOM", "SLIDE_OUT_TO_LEFT", "SLIDE_OUT_TO_RIGHT",
  "SLIDE_OUT_TO_TOP", "SLIDE_OUT_TO_BOTTOM", "MOVE_OUT_TO_LEFT", "MOVE_OUT_TO_RIGHT", "MOVE_OUT_TO_TOP",
  "MOVE_OUT_TO_BOTTOM", "SMART_ANIMATE",
] as const;

const TRANSITION_CURVES = ["EASE_IN", "EASE_OUT", "EASE_IN_AND_OUT", "LINEAR", "GENTLE", "QUICK", "BOUNCY", "SLOW"] as const;

const colour = z
  .string()
  .min(1)
  .describe("A FigJam colour name such as yellow, green or lightGray (get_board lists the ones in use), or a hex colour");
const x = z.number().optional().describe("Left edge, in the parent's coordinates. Without x, y or parentId the item is centred in view.");
const y = z.number().optional().describe("Top edge, in the parent's coordinates");
const parentId = nodeId.optional().describe("A section to put it in");
const slideId = nodeId.describe("The slide's node id, from get_slides");

export const BOARDS_PLUGIN_TOOLS: Record<string, PluginToolDef> = {
  /* FigJam */
  get_board: {
    description:
      "FigJam: read a board as compact JSON — stickies (text, colour, author, position), shapes with text, connectors (what they join, label, line type), sections with their children, tables (cell text), code blocks, text and stamps, plus a count of every layer type. Only works when the plugin runs in a FigJam file.",
    schema: z.object({
      pageId: z.string().optional().describe("A page other than the current one"),
      maxItems: z.number().int().min(1).max(10_000).optional().describe("Stop listing after this many items (default 500); counts still cover everything"),
      fileKey,
    }),
  },
  create_sticky: {
    description: "FigJam: add a sticky note.",
    schema: z.object({
      text: z.string(),
      color: colour.optional(),
      x,
      y,
      parentId,
      wide: z.boolean().optional().describe("A wide sticky instead of a square one"),
      fileKey,
    }),
    editing: true,
  },
  create_shape_with_text: {
    description: "FigJam: add a shape with text in it, e.g. a flowchart box or decision diamond.",
    schema: z.object({
      shapeType: z.enum(SHAPE_TYPES),
      text: z.string(),
      x,
      y,
      width: z.number().positive().optional(),
      height: z.number().positive().optional(),
      fill: colour.optional(),
      parentId,
      fileKey,
    }),
    editing: true,
  },
  create_connector: {
    description: "FigJam: connect two items (stickies, shapes, sections…) with a connector line that follows them when they move.",
    schema: z.object({
      startNodeId: nodeId,
      endNodeId: nodeId,
      label: z.string().optional(),
      lineType: z.enum(["ELBOWED", "STRAIGHT", "CURVED"]).optional(),
      startCap: z.enum(CONNECTOR_CAPS).optional().describe("Default NONE"),
      endCap: z.enum(CONNECTOR_CAPS).optional().describe("Default is FigJam's arrow"),
      startMagnet: z.enum(MAGNETS).optional().describe("Which side it attaches to (default AUTO)"),
      endMagnet: z.enum(MAGNETS).optional(),
      fileKey,
    }),
    editing: true,
  },
  create_table: {
    description: "FigJam: add a table, optionally filled with text row by row.",
    schema: z.object({
      rows: z.number().int().min(1).max(100),
      columns: z.number().int().min(1).max(50),
      cells: z.array(z.array(z.string())).optional().describe("Text per row; missing cells stay empty"),
      x,
      y,
      fileKey,
    }),
    editing: true,
  },
  create_code_block: {
    description: "FigJam: add a code block with syntax highlighting.",
    schema: z.object({ code: z.string(), language: z.enum(CODE_LANGUAGES).optional(), x, y, fileKey }),
    editing: true,
  },
  generate_diagram: {
    description:
      "FigJam: draw a Mermaid flowchart as real FigJam shapes, connectors and sections, laid out automatically. Supports flowchart/graph with TD, TB, BT, LR or RL; node shapes [rect], (round), {diamond}, ((circle)), ([stadium]), [(database)], {{hexagon}}, [[subroutine]], [/parallelogram/]; edges -->, ---, -.->, ==> with |label| or -- label -->; subgraphs become sections; %% comments. Styling (classDef, style, click) is skipped and reported in warnings. Returns the id of every shape, connector and section, keyed by Mermaid id. Up to 300 nodes.",
    schema: z.object({
      mermaid: z.string().trim().min(1).describe('Mermaid source, starting with e.g. "flowchart LR"'),
      x: z.number().optional().describe("Left edge of the diagram (default: centred in view)"),
      y: z.number().optional().describe("Top edge of the diagram"),
      direction: z.enum(["TB", "TD", "BT", "LR", "RL"]).optional().describe("Overrides the direction in the Mermaid header"),
      fileKey,
    }),
    editing: true,
  },

  /* Slides */
  get_slides: {
    description:
      "Figma Slides: the deck as rows of slides with id, name, whether it is skipped, its transition and the first few text layers of each. Only works when the plugin runs in a Slides file. Edit a slide's content with the usual tools (create_text, create_frame, set_text_content, …) using the slide id as parentId.",
    schema: z.object({
      textNodesPerSlide: z.number().int().min(0).max(50).optional().describe("Text layers summarised per slide (default 5, 0 for none)"),
      fileKey,
    }),
  },
  create_slide: {
    description: "Figma Slides: add a slide, at the end of the deck or at a row and position. Use a row one past the last to start a new row.",
    schema: z.object({
      row: z.number().int().min(0).optional(),
      index: z.number().int().min(0).optional().describe("Position within the row; needs row"),
      name: z
        .string()
        .optional()
        .describe("Layer name. Figma Slides renames slides to their position number when the deck changes, so it rarely lasts; identify slides by id"),
      fileKey,
    }),
    editing: true,
  },
  reorder_slides: {
    description: "Figma Slides: rearrange the deck. Pass every slide id exactly once, grouped into rows in the new order.",
    schema: z.object({ grid: z.array(z.array(nodeId).min(1)).min(1).describe("Slide ids per row, e.g. [['1:2','1:3'],['1:4']]"), fileKey }),
    editing: true,
  },
  delete_slide: {
    description: "Figma Slides: delete a slide and everything on it.",
    schema: z.object({ slideId, confirm, fileKey }),
    editing: true,
  },
  set_slide_transition: {
    description: "Figma Slides: set the transition that plays when this slide appears. Values left out keep the slide's current ones.",
    schema: z.object({
      slideId,
      style: z.enum(TRANSITION_STYLES),
      duration: z.number().min(0).optional().describe("Length of the transition, as Figma's SlideTransition.duration"),
      curve: z.enum(TRANSITION_CURVES).optional(),
      trigger: z.enum(["ON_CLICK", "AFTER_DELAY"]).optional(),
      delay: z.number().min(0).optional().describe("With trigger AFTER_DELAY"),
      fileKey,
    }),
    editing: true,
  },
  focus_slide: {
    description: "Figma Slides: make a slide the focused one, as when it is opened in single-slide view.",
    schema: z.object({ slideId, fileKey }),
  },
};
