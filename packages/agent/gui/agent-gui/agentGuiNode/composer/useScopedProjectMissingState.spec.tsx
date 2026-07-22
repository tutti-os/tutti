import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useScopedProjectMissingState } from "./useScopedProjectMissingState";

describe("useScopedProjectMissingState", () => {
  it("does not carry missing results across session scopes", () => {
    const rendered = renderHook(
      ({ scopeKey }) => useScopedProjectMissingState(scopeKey),
      { initialProps: { scopeKey: "session:one" } }
    );

    act(() => rendered.result.current[1](true));
    expect(rendered.result.current[0]).toBe(true);

    const reportForFirstSession = rendered.result.current[1];
    rendered.rerender({ scopeKey: "session:two" });
    expect(rendered.result.current[0]).toBe(false);

    act(() => reportForFirstSession(true));
    expect(rendered.result.current[0]).toBe(false);

    act(() => rendered.result.current[1](true));
    expect(rendered.result.current[0]).toBe(true);

    rendered.rerender({ scopeKey: "session:one" });
    expect(rendered.result.current[0]).toBe(false);
  });
});
