import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useScopedProjectMissingState } from "./useScopedProjectMissingState";

describe("useScopedProjectMissingState", () => {
  it("keeps results for the same path and rejects stale results after a path change", () => {
    const rendered = renderHook(
      ({ scopeKey }) => useScopedProjectMissingState(scopeKey),
      { initialProps: { scopeKey: "/workspace/one" } }
    );

    act(() => rendered.result.current[1](true));
    expect(rendered.result.current[0]).toBe(true);
    const reportForFirstPath = rendered.result.current[1];

    rendered.rerender({ scopeKey: "/workspace/one" });
    expect(rendered.result.current[0]).toBe(true);
    expect(rendered.result.current[1]).toBe(reportForFirstPath);

    rendered.rerender({ scopeKey: "/workspace/two" });
    expect(rendered.result.current[0]).toBe(false);

    act(() => reportForFirstPath(true));
    expect(rendered.result.current[0]).toBe(false);

    act(() => rendered.result.current[1](true));
    expect(rendered.result.current[0]).toBe(true);

    rendered.rerender({ scopeKey: "/workspace/one" });
    expect(rendered.result.current[0]).toBe(false);
  });
});
