import { act, render } from "@testing-library/react";
import { useState, type Dispatch, type SetStateAction } from "react";
import { describe, expect, it } from "vitest";

import { createRenderBudgetProbe } from "./renderBudget";

function Counter({
  label,
  registerSetter
}: {
  label: string;
  registerSetter: (setter: Dispatch<SetStateAction<number>>) => void;
}) {
  const [count, setCount] = useState(0);
  registerSetter(setCount);
  return (
    <output>
      {label}:{count}
    </output>
  );
}

describe("createRenderBudgetProbe", () => {
  it("counts commits per probe id and resets counters", () => {
    const probe = createRenderBudgetProbe();
    let bump: Dispatch<SetStateAction<number>> | null = null;

    render(
      probe.wrap(
        "counter",
        <Counter
          label="a"
          registerSetter={(setter) => {
            bump = setter;
          }}
        />
      )
    );
    expect(probe.renderCount("counter")).toBe(1);

    probe.reset();
    expect(probe.renderCount("counter")).toBe(0);

    act(() => {
      bump?.((value) => value + 1);
    });
    expect(probe.renderCount("counter")).toBe(1);
  });

  it("keeps sibling probes independent", () => {
    const probe = createRenderBudgetProbe();
    let bumpLeft: Dispatch<SetStateAction<number>> | null = null;

    render(
      <>
        {probe.wrap(
          "left",
          <Counter
            label="left"
            registerSetter={(setter) => {
              bumpLeft = setter;
            }}
          />
        )}
        {probe.wrap(
          "right",
          <Counter label="right" registerSetter={() => {}} />
        )}
      </>
    );
    probe.reset();

    act(() => {
      bumpLeft?.((value) => value + 1);
    });

    expect(probe.renderCount("left")).toBe(1);
    expect(probe.renderCount("right")).toBe(0);
    probe.assertRenderBudget({ left: 1, right: 0 });
  });

  it("fails the budget assertion when a probe exceeds its budget", () => {
    const probe = createRenderBudgetProbe();
    let bump: Dispatch<SetStateAction<number>> | null = null;

    render(
      probe.wrap(
        "busy",
        <Counter
          label="busy"
          registerSetter={(setter) => {
            bump = setter;
          }}
        />
      )
    );
    probe.reset();

    act(() => {
      bump?.((value) => value + 1);
    });
    act(() => {
      bump?.((value) => value + 1);
    });

    expect(() => probe.assertRenderBudget({ busy: 1 })).toThrowError(
      /rendered 2 time\(s\), budget is 1/
    );
  });

  it("fails when asserting a probe id that was never wrapped", () => {
    const probe = createRenderBudgetProbe();
    expect(() => probe.assertRenderBudget({ ghost: 0 })).toThrowError(
      /never wrapped/
    );
  });
});
