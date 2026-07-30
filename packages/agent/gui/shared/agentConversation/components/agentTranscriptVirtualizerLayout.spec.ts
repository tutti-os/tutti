import { describe, expect, it } from "vitest";
import {
  agentTranscriptResponseSpacerHeight,
  buildAgentTranscriptVirtualLayout,
  compensateAgentTranscriptDistanceForAnchor,
  distanceFromBottomForAgentTranscriptTurn,
  findAgentTranscriptCompensationAnchor,
  findAgentTranscriptTurnIndexAtOffset,
  findAgentTranscriptVirtualRange,
  preserveAgentTranscriptVirtualRangeAnchor,
  projectAgentTranscriptVirtualRange,
  rangeContainsAgentTranscriptRange,
  updateAgentTranscriptVirtualViewportState
} from "./agentTranscriptVirtualizerLayout";

const entries = Array.from({ length: 6 }, (_, index) => ({
  gapAfterPx: 12,
  key: `turn-${index}`
}));

describe("agentTranscriptVirtualizerLayout", () => {
  it("sizes the response spacer from the usable viewport", () => {
    expect(
      agentTranscriptResponseSpacerHeight({
        bottomInsetPx: 120,
        viewportHeightPx: 800
      })
    ).toBeCloseTo(440);
    expect(
      agentTranscriptResponseSpacerHeight({
        bottomInsetPx: 120,
        viewportHeightPx: 480
      })
    ).toBe(120);
    expect(
      agentTranscriptResponseSpacerHeight({
        bottomInsetPx: 120,
        viewportHeightPx: 300
      })
    ).toBe(0);
  });

  it("builds stable offsets from measured and estimated heights", () => {
    const layout = buildAgentTranscriptVirtualLayout(entries, {
      "turn-0": 100,
      "turn-1": 200
    });

    expect(layout.topOffsetsPx).toEqual([0, 112, 324, 616, 908, 1200]);
    expect(layout.totalHeightPx).toBe(1480);
    expect(layout.bottomOffsetsPx).toEqual([1380, 1168, 876, 584, 292, 0]);
  });

  it("finds a bottom-relative window with two turns of overscan", () => {
    const layout = buildAgentTranscriptVirtualLayout(entries, {});

    expect(
      findAgentTranscriptVirtualRange({
        distanceFromBottomPx: 0,
        layout,
        viewportHeightPx: 480
      })
    ).toEqual({ endIndex: 6, startIndex: 2 });
  });

  it("preserves a stable key window when turns are prepended", () => {
    const previousLayout = buildAgentTranscriptVirtualLayout(entries, {});
    const nextLayout = buildAgentTranscriptVirtualLayout(
      [{ gapAfterPx: 12, key: "older" }, ...entries],
      {}
    );

    expect(
      preserveAgentTranscriptVirtualRangeAnchor({
        anchorKey: "turn-2",
        layout: nextLayout,
        previousRange: { endIndex: 6, startIndex: 2 }
      })
    ).toEqual({ endIndex: 7, startIndex: 3 });
    expect(
      compensateAgentTranscriptDistanceForAnchor({
        anchorKey: "turn-2",
        distanceFromBottomPx: 500,
        nextLayout,
        previousLayout
      })
    ).toBe(500);
  });

  it("projects the render-time range by stable key before layout effects run", () => {
    const previousLayout = buildAgentTranscriptVirtualLayout(entries, {});
    const nextLayout = buildAgentTranscriptVirtualLayout(
      [{ gapAfterPx: 12, key: "older" }, ...entries],
      {}
    );

    expect(
      projectAgentTranscriptVirtualRange({
        current: {
          distanceFromBottomPx: 500,
          renderedRange: { endIndex: 6, startIndex: 2 },
          turnKeys: previousLayout.turnKeys,
          viewportHeightPx: 480
        },
        layout: nextLayout
      })
    ).toEqual({ endIndex: 7, startIndex: 3 });
  });

  it("projects the render-time range around an active locate target", () => {
    const layout = buildAgentTranscriptVirtualLayout(
      Array.from({ length: 20 }, (_, index) => ({
        gapAfterPx: 0,
        key: `turn-${index}`
      })),
      {}
    );

    const range = projectAgentTranscriptVirtualRange({
      current: {
        distanceFromBottomPx: 0,
        renderedRange: { endIndex: 20, startIndex: 16 },
        turnKeys: layout.turnKeys,
        viewportHeightPx: 480
      },
      layout,
      locatingTurnKey: "turn-1"
    });

    expect(range.startIndex).toBeLessThanOrEqual(1);
    expect(range.endIndex).toBeGreaterThan(1);
  });

  it("does not compensate from a detached anchor", () => {
    const previousLayout = buildAgentTranscriptVirtualLayout(entries, {});
    const nextLayout = buildAgentTranscriptVirtualLayout(entries.slice(1), {});

    expect(
      preserveAgentTranscriptVirtualRangeAnchor({
        anchorKey: "turn-0",
        layout: nextLayout,
        previousRange: { endIndex: 4, startIndex: 0 }
      })
    ).toBeNull();
    expect(
      compensateAgentTranscriptDistanceForAnchor({
        anchorKey: "turn-0",
        distanceFromBottomPx: 500,
        nextLayout,
        previousLayout
      })
    ).toBeNull();
  });

  it("prefers a visible measured turn over the overscan start for compensation", () => {
    const layout = buildAgentTranscriptVirtualLayout(entries, {
      "turn-2": 280,
      "turn-3": 280
    });

    expect(
      findAgentTranscriptCompensationAnchor({
        distanceFromBottomPx: 500,
        fallbackRange: { endIndex: 6, startIndex: 0 },
        layout,
        measuredHeightsByKey: {
          "turn-2": 280,
          "turn-3": 280
        },
        viewportHeightPx: 480
      })
    ).toBe("turn-2");
    expect(
      findAgentTranscriptCompensationAnchor({
        distanceFromBottomPx: 500,
        fallbackRange: { endIndex: 6, startIndex: 0 },
        layout,
        measuredHeightsByKey: {},
        viewportHeightPx: 480
      })
    ).toBe("turn-0");
  });

  it("maps list offsets and scroll targets without mounted DOM", () => {
    const layout = buildAgentTranscriptVirtualLayout(entries, {});

    expect(findAgentTranscriptTurnIndexAtOffset(layout, 600)).toBe(2);
    expect(
      distanceFromBottomForAgentTranscriptTurn({
        align: "top",
        layout,
        turnKey: "turn-1",
        viewportHeightPx: 480
      })
    ).toBe(1438);
    expect(
      rangeContainsAgentTranscriptRange(
        { endIndex: 6, startIndex: 1 },
        { endIndex: 5, startIndex: 2 }
      )
    ).toBe(true);
  });

  it("commits distance, range, turn keys, and viewport height together", () => {
    const layout = buildAgentTranscriptVirtualLayout(entries, {});
    const current = {
      distanceFromBottomPx: 0,
      renderedRange: { endIndex: 6, startIndex: 2 },
      turnKeys: layout.turnKeys,
      viewportHeightPx: 480
    };

    expect(
      updateAgentTranscriptVirtualViewportState({
        current,
        distanceFromBottomPx: 20_000,
        layout,
        viewportHeightPx: 420
      })
    ).toEqual({
      distanceFromBottomPx: layout.totalHeightPx,
      renderedRange: { endIndex: 3, startIndex: 0 },
      turnKeys: layout.turnKeys,
      viewportHeightPx: 420
    });
  });
});
