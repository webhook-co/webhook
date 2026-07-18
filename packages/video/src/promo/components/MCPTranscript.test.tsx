import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  blockDurationFrames,
  blockStartFrames,
  computeRenderBlocks,
  MCP_TRANSCRIPT_GAP_FRAMES,
  MCP_TRANSCRIPT_SLIDE_FRAMES,
  MCPTranscriptView,
  responseSlideProgress,
  type MCPTranscriptBlock,
} from "./MCPTranscript";

// The brief S14→S15 pair: a `triggers.create` call + its subscription-id
// response, followed by the `triggers.wait` call. Real product strings.
const CALL_1: MCPTranscriptBlock = { kind: "call", text: "triggers.create" };
const RESPONSE_1: MCPTranscriptBlock = { kind: "response", text: "sub_9f21a" };
const CALL_2: MCPTranscriptBlock = { kind: "call", text: "triggers.wait" };

describe("blockDurationFrames", () => {
  it("types a call block 1 char/frame at the default 30cps/30fps rate", () => {
    expect(blockDurationFrames(CALL_1)).toBe(CALL_1.text.length);
    expect(blockDurationFrames(CALL_2)).toBe(CALL_2.text.length);
  });

  it("scales a call block's duration proportionally for a non-default cps", () => {
    // 15cps at 30fps == 1 char every 2 frames.
    expect(blockDurationFrames(CALL_1, 15)).toBe(CALL_1.text.length * 2);
  });

  it("gives every response block the fixed slide duration, regardless of text length", () => {
    expect(blockDurationFrames(RESPONSE_1)).toBe(MCP_TRANSCRIPT_SLIDE_FRAMES);
    expect(blockDurationFrames({ kind: "response", text: "a much longer returned result" })).toBe(
      MCP_TRANSCRIPT_SLIDE_FRAMES,
    );
  });
});

// blockStartFrames is the ordering contract: block 0 starts at startFrame, and every later
// block starts strictly after the previous one has fully revealed plus the gap — never
// overlapping, never simultaneous, always in array order.
describe("blockStartFrames", () => {
  it("starts the first block exactly at startFrame", () => {
    const starts = blockStartFrames([CALL_1], 1114);
    expect(starts).toEqual([1114]);
  });

  it("starts each later block exactly GAP frames after the previous one's own duration", () => {
    const starts = blockStartFrames([CALL_1, RESPONSE_1, CALL_2], 1114);
    const call1End = 1114 + CALL_1.text.length;
    const responseStart = call1End + MCP_TRANSCRIPT_GAP_FRAMES;
    const responseEnd = responseStart + MCP_TRANSCRIPT_SLIDE_FRAMES;
    const call2Start = responseEnd + MCP_TRANSCRIPT_GAP_FRAMES;

    expect(starts).toEqual([1114, responseStart, call2Start]);
  });

  it("produces strictly increasing starts across an arbitrary block sequence (order preserved)", () => {
    const blocks: MCPTranscriptBlock[] = [CALL_1, RESPONSE_1, CALL_2, RESPONSE_1];
    const starts = blockStartFrames(blocks, 0);
    // Same length as `blocks`, so every index below is defined.
    for (let i = 1; i < starts.length; i++) {
      expect(starts[i]!).toBeGreaterThan(starts[i - 1]!);
    }
  });

  it("returns an empty array for an empty transcript", () => {
    expect(blockStartFrames([], 500)).toEqual([]);
  });
});

// responseSlideProgress is the "on rails" slide-in curve: rests at 0 before departure,
// reaches exactly 1 once settled, and never regresses (no bounce on a chat bubble).
describe("responseSlideProgress", () => {
  it("is 0 before and at the moment the response begins sliding", () => {
    expect(responseSlideProgress(-5)).toBe(0);
    expect(responseSlideProgress(0)).toBe(0);
  });

  it("reaches exactly 1 at MCP_TRANSCRIPT_SLIDE_FRAMES and clamps there afterward", () => {
    expect(responseSlideProgress(MCP_TRANSCRIPT_SLIDE_FRAMES)).toBe(1);
    expect(responseSlideProgress(MCP_TRANSCRIPT_SLIDE_FRAMES + 100)).toBe(1);
  });

  it("is monotonically non-decreasing across the slide window", () => {
    let prev = -Infinity;
    for (let f = -2; f <= MCP_TRANSCRIPT_SLIDE_FRAMES + 2; f++) {
      const p = responseSlideProgress(f);
      expect(p).toBeGreaterThanOrEqual(prev);
      prev = p;
    }
  });
});

// computeRenderBlocks is the full per-frame reveal timeline: order, timing, and per-block
// reveal state, all as one pure function — the exact surface the Remotion wrapper calls.
describe("computeRenderBlocks", () => {
  const blocks: MCPTranscriptBlock[] = [CALL_1, RESPONSE_1, CALL_2];
  const starts = blockStartFrames(blocks, 1114);
  // `blocks` has exactly 3 entries, so `starts` does too — every index below is defined.
  const call1Start = starts[0]!;
  const responseStart = starts[1]!;
  const call2Start = starts[2]!;

  it("renders nothing before the first block's own start frame", () => {
    expect(computeRenderBlocks(blocks, 1114, call1Start - 1)).toEqual([]);
  });

  it("reveals the call block's exact typed substring, character by character", () => {
    expect(computeRenderBlocks(blocks, 1114, call1Start)[0]).toMatchObject({
      kind: "call",
      visibleText: "",
      typedDone: false,
    });
    expect(computeRenderBlocks(blocks, 1114, call1Start + 3)[0]).toMatchObject({
      visibleText: CALL_1.text.slice(0, 3),
      typedDone: false,
    });
    expect(computeRenderBlocks(blocks, 1114, call1Start + CALL_1.text.length)[0]).toMatchObject({
      visibleText: CALL_1.text,
      typedDone: true,
    });
  });

  it("keeps a finished call block in the list once the response begins (history is kept)", () => {
    const rendered = computeRenderBlocks(blocks, 1114, responseStart);
    expect(rendered).toHaveLength(2);
    expect(rendered[0]).toMatchObject({ kind: "call", typedDone: true });
    expect(rendered[1]).toMatchObject({ kind: "response", opacity: 0 });
  });

  it("preserves block order in the rendered array once every block has started", () => {
    const rendered = computeRenderBlocks(blocks, 1114, call2Start + CALL_2.text.length);
    expect(rendered.map((b) => b.kind)).toEqual(["call", "response", "call"]);
    expect(rendered.map((b) => b.text)).toEqual([CALL_1.text, RESPONSE_1.text, CALL_2.text]);
  });

  it("slides the response block's opacity/translateX in together, settled by the end of its window", () => {
    const settled = computeRenderBlocks(
      blocks,
      1114,
      responseStart + MCP_TRANSCRIPT_SLIDE_FRAMES,
    )[1];
    expect(settled).toMatchObject({ kind: "response", opacity: 1, translateX: 0 });
  });

  it("never reveals the second call before the response has settled plus the gap", () => {
    expect(computeRenderBlocks(blocks, 1114, call2Start - 1)).toHaveLength(2);
    expect(computeRenderBlocks(blocks, 1114, call2Start)).toHaveLength(3);
  });
});

describe("MCPTranscriptView", () => {
  it("renders each call block's visible text and the blinking cursor state", () => {
    const { getByText, container } = render(
      <MCPTranscriptView
        blocks={[
          { kind: "call", text: "trig", visibleText: "trig", typedDone: false, cursorOn: true },
        ]}
      />,
    );
    expect(getByText("trig", { exact: false })).toBeTruthy();
    const cursor = container.querySelector('[data-testid="mcp-transcript-call"] span[aria-hidden]');
    expect((cursor as HTMLElement | null)?.style.opacity).toBe("1");
  });

  it("hides the cursor once a call block has finished typing", () => {
    const { container } = render(
      <MCPTranscriptView
        blocks={[
          {
            kind: "call",
            text: "triggers.create",
            visibleText: "triggers.create",
            typedDone: true,
            cursorOn: true,
          },
        ]}
      />,
    );
    expect(
      container.querySelector('[data-testid="mcp-transcript-call"] span[aria-hidden]'),
    ).toBeNull();
  });

  it("renders a response block's full text with its computed opacity/offset", () => {
    const { getByTestId } = render(
      <MCPTranscriptView
        blocks={[{ kind: "response", text: "sub_9f21a", opacity: 0.5, translateX: 28 }]}
      />,
    );
    const bubble = getByTestId("mcp-transcript-response");
    expect(bubble.textContent).toBe("sub_9f21a");
    expect(bubble.style.opacity).toBe("0.5");
    expect(bubble.style.transform).toBe("translateX(28px)");
  });

  it("renders blocks in the array order it is handed", () => {
    const { getByTestId } = render(
      <MCPTranscriptView
        blocks={[
          {
            kind: "call",
            text: "triggers.create",
            visibleText: "triggers.create",
            typedDone: true,
            cursorOn: false,
          },
          { kind: "response", text: "sub_9f21a", opacity: 1, translateX: 0 },
        ]}
      />,
    );
    const transcript = getByTestId("mcp-transcript");
    expect(transcript.children[0]?.getAttribute("data-testid")).toBe("mcp-transcript-call");
    expect(transcript.children[1]?.getAttribute("data-testid")).toBe("mcp-transcript-response");
  });
});
