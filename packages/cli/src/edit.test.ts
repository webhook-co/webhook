import { describe, expect, it } from "vitest";

import { applyEdit, decodeEditableBody, editorFromEnv } from "./edit.js";

describe("editorFromEnv", () => {
  it("prefers $VISUAL over $EDITOR", () => {
    expect(editorFromEnv({ VISUAL: "code --wait", EDITOR: "vi" })).toBe("code --wait");
  });

  it("falls back to $EDITOR when $VISUAL is unset/empty", () => {
    expect(editorFromEnv({ EDITOR: "nano" })).toBe("nano");
    expect(editorFromEnv({ VISUAL: "  ", EDITOR: "nano" })).toBe("nano");
  });

  it("returns undefined when neither is set", () => {
    expect(editorFromEnv({})).toBeUndefined();
    expect(editorFromEnv({ VISUAL: "", EDITOR: "" })).toBeUndefined();
  });
});

describe("decodeEditableBody", () => {
  it("decodes a UTF-8 (JSON) body to text", () => {
    const bytes = new TextEncoder().encode('{"hello":"wörld"}');
    expect(decodeEditableBody(bytes)).toBe('{"hello":"wörld"}');
  });

  it("returns null for a non-UTF-8 (binary) body", () => {
    // A lone 0xFF byte is invalid UTF-8 → not editable as text.
    expect(decodeEditableBody(new Uint8Array([0xff, 0xfe, 0x00]))).toBeNull();
  });
});

describe("applyEdit", () => {
  it("treats an identical save as unchanged", () => {
    expect(applyEdit('{"a":1}', '{"a":1}')).toEqual({ text: '{"a":1}', changed: false });
  });

  it("treats a save that only ADDED a trailing newline as unchanged (the common editor :wq)", () => {
    // The original has no trailing newline; vim/nano append one — this must NOT count as an edit.
    expect(applyEdit('{"a":1}', '{"a":1}\n')).toEqual({ text: '{"a":1}', changed: false });
  });

  it("treats a save that only REMOVED a trailing newline as unchanged", () => {
    expect(applyEdit('{"a":1}\n', '{"a":1}')).toEqual({ text: '{"a":1}\n', changed: false });
  });

  it("reports a real content change verbatim", () => {
    expect(applyEdit('{"a":1}', '{"a":2}')).toEqual({ text: '{"a":2}', changed: true });
  });
});
