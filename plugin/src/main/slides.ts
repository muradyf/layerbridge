/**
 * Figma Slides tools: read the slide grid, add, reorder and delete slides, set
 * transitions and focus a slide. Slide content itself is edited with the
 * ordinary design tools (create_text, create_frame, set_*) using the slide id
 * as the parent.
 *
 * Every tool refuses to run outside Figma Slides (see ./editors).
 */
import { validateSlideGrid, clip } from "./boardsPure";
import { SLIDES_TOOLS, editorRefusal } from "./editors";
import { arr, need, num, ok, requireEditor, str, type Request, type Response } from "./features";
import { resolveNode } from "./robust";

/** getSlideGrid is deprecated in favour of getCanvasGrid; use whichever this Figma has. */
const slideGrid = (): SlideNode[][] => {
  const grid: SceneNode[][] =
    typeof figma.getCanvasGrid === "function" ? figma.getCanvasGrid() : figma.getSlideGrid();
  return grid.map((row) => row.filter((node): node is SlideNode => node.type === "SLIDE"));
};

const setGrid = (grid: SlideNode[][]) => {
  if (typeof figma.setCanvasGrid === "function") figma.setCanvasGrid(grid);
  else figma.setSlideGrid(grid);
};

const gridIds = (grid: SlideNode[][]) => grid.map((row) => row.map((slide) => slide.id));

const locate = (grid: SlideNode[][], id: string) => {
  for (let row = 0; row < grid.length; row++) {
    const index = grid[row].findIndex((slide) => slide.id === id);
    if (index >= 0) return { row, index };
  }
  return undefined;
};

const slideById = async (id: string): Promise<SlideNode> => {
  const node = await resolveNode(id);
  if (node.type !== "SLIDE") throw new Error(`Node ${id} is a ${node.type}, not a slide`);
  return node;
};

const transitionOf = (slide: SlideNode): SlideTransition | undefined => {
  try {
    return slide.getSlideTransition();
  } catch {
    return undefined;
  }
};

export const handleSlidesRequest = async (request: Request): Promise<Response | null> => {
  if (!SLIDES_TOOLS.has(request.type)) return null;
  const refusal = editorRefusal(request.type, figma.editorType);
  if (refusal) throw new Error(refusal);
  const p = request.params ?? {};

  switch (request.type) {
    case "get_slides": {
      const perSlide = num(p.textNodesPerSlide) ?? 5;
      const grid = slideGrid();
      let slideCount = 0;
      const rows = grid.map((row, rowIndex) => ({
        row: rowIndex,
        rowId: row[0]?.parent?.type === "SLIDE_ROW" ? row[0].parent.id : undefined,
        slides: row.map((slide, index) => {
          slideCount++;
          const texts = perSlide > 0 ? slide.findAllWithCriteria({ types: ["TEXT"] }) : [];
          return {
            id: slide.id,
            name: slide.name,
            row: rowIndex,
            index,
            skipped: slide.isSkippedSlide,
            transition: transitionOf(slide),
            ...(perSlide > 0
              ? { text: texts.slice(0, perSlide).map((t) => clip(t.characters, 200)), textNodeCount: texts.length }
              : {}),
          };
        }),
      }));
      return ok(request, {
        slideCount,
        rowCount: rows.length,
        focusedSlideId: figma.currentPage.focusedSlide?.id ?? null,
        view: figma.viewport.slidesView,
        rows,
      });
    }

    case "create_slide": {
      requireEditor(request.type);
      const row = num(p.row);
      const index = num(p.index);
      if (index !== undefined && row === undefined) throw new Error("index needs row");
      const grid = slideGrid();
      let slide: SlideNode;
      if (row === undefined) {
        slide = figma.createSlide();
      } else {
        if (row > grid.length) {
          throw new Error(`row ${row} is past the end: the deck has ${grid.length} rows, so ${grid.length} starts a new one`);
        }
        const rowLength = grid[row]?.length ?? 0;
        if (index !== undefined && index > rowLength) {
          throw new Error(`index ${index} is past the end of row ${row}, which has ${rowLength} slides`);
        }
        if (row === grid.length) figma.createSlideRow();
        slide = figma.createSlide(row, index ?? rowLength);
      }
      if (str(p.name)) slide.name = str(p.name)!;
      return ok(request, { slideId: slide.id, name: slide.name, ...locate(slideGrid(), slide.id) });
    }

    case "reorder_slides": {
      requireEditor(request.type);
      const wanted = need(arr<string[]>(p.grid), "grid");
      const current = slideGrid();
      const problem = validateSlideGrid(gridIds(current), wanted);
      if (problem) throw new Error(problem);
      const byId = new Map(current.flat().map((slide) => [slide.id, slide]));
      setGrid(wanted.map((row) => row.map((id) => byId.get(id)!)));
      return ok(request, { grid: gridIds(slideGrid()) });
    }

    case "delete_slide": {
      requireEditor(request.type);
      if (p.confirm !== true) throw new Error("delete_slide requires confirm: true");
      const slide = await slideById(need(str(p.slideId), "slideId"));
      const deleted = { id: slide.id, name: slide.name, ...locate(slideGrid(), slide.id) };
      slide.remove();
      return ok(request, { deleted, slideCount: slideGrid().flat().length });
    }

    case "set_slide_transition": {
      requireEditor(request.type);
      const slide = await slideById(need(str(p.slideId), "slideId"));
      const current = transitionOf(slide);
      const trigger = str(p.trigger) as SlideTransition["timing"]["type"] | undefined;
      const timing: SlideTransition["timing"] = trigger
        ? { type: trigger, ...(num(p.delay) !== undefined ? { delay: num(p.delay) } : {}) }
        : current?.timing ?? { type: "ON_CLICK" };
      slide.setSlideTransition({
        style: need(str(p.style), "style") as SlideTransition["style"],
        duration: num(p.duration) ?? current?.duration ?? 0.3,
        curve: (str(p.curve) as SlideTransition["curve"] | undefined) ?? current?.curve ?? "EASE_OUT",
        timing,
      });
      return ok(request, { slideId: slide.id, transition: transitionOf(slide) });
    }

    case "focus_slide": {
      const slide = await slideById(need(str(p.slideId), "slideId"));
      figma.currentPage.focusedSlide = slide;
      return ok(request, {
        focusedSlideId: figma.currentPage.focusedSlide?.id ?? null,
        view: figma.viewport.slidesView,
      });
    }

    default:
      return null;
  }
};
