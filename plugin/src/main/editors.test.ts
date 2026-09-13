import { describe, expect, test } from "bun:test";
import { editorName, editorRefusal, withEditorHint } from "./editors";

describe("editorRefusal", () => {
  test("FigJam tools only run in FigJam, and the message names where the plugin is", () => {
    expect(editorRefusal("create_sticky", "figjam")).toBeNull();
    expect(editorRefusal("create_sticky", "figma")).toContain("Figma design");
    expect(editorRefusal("generate_diagram", "dev")).toContain("Dev Mode");
    expect(editorRefusal("get_board", "slides")).toContain("Figma Slides");
  });

  test("Slides tools only run in Slides", () => {
    expect(editorRefusal("get_slides", "slides")).toBeNull();
    expect(editorRefusal("delete_slide", "figjam")).toContain("FigJam");
    expect(editorRefusal("focus_slide", "figma")).toContain("Figma design");
  });

  test("design-only APIs are refused in FigJam and Slides but not in design or Dev Mode", () => {
    expect(editorRefusal("create_component", "figjam")).toContain("only works in Figma design");
    expect(editorRefusal("create_paint_style", "slides")).toContain("Figma Slides");
    expect(editorRefusal("create_component", "figma")).toBeNull();
    // Dev Mode's own read-only refusal happens later, in requireEditor.
    expect(editorRefusal("create_component", "dev")).toBeNull();
  });

  test("Slides has no variables or sections, FigJam may", () => {
    expect(editorRefusal("create_variable", "slides")).toContain("not available in Figma Slides");
    expect(editorRefusal("create_section", "slides")).not.toBeNull();
    expect(editorRefusal("create_section", "figjam")).toBeNull();
  });

  test("everything else is left to run", () => {
    for (const editor of ["figma", "figjam", "slides", "dev"]) {
      expect(editorRefusal("get_document", editor)).toBeNull();
      expect(editorRefusal("create_text", editor)).toBeNull();
    }
  });
});

describe("withEditorHint", () => {
  test("adds the editor to design tool errors outside Figma design", () => {
    const msg = withEditorHint("set_reactions", "not a function", "figjam");
    expect(msg).toStartWith("not a function");
    expect(msg).toContain("FigJam");
  });

  test("leaves design, Dev Mode and board tool errors alone", () => {
    expect(withEditorHint("set_reactions", "boom", "figma")).toBe("boom");
    expect(withEditorHint("set_reactions", "boom", "dev")).toBe("boom");
    expect(withEditorHint("create_sticky", "boom", "figjam")).toBe("boom");
  });

  test("unknown editors are named as-is", () => {
    expect(editorName("buzz")).toBe("Figma Buzz");
    expect(editorName("future")).toBe("future");
  });
});
