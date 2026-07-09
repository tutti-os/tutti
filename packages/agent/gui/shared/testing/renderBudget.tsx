import { Profiler, type ReactNode } from "react";

// Render-budget test infrastructure for the agent GUI refactor
// (docs/architecture/agent-gui-refactor-plan.md, section 5.2 item 3).
//
// Performance work is accepted when a budget test goes green, not when more
// memoization is added. Feature-module slices wrap their components with a
// probe and assert commit counts for typical interactions, for example:
//
//   const probe = createRenderBudgetProbe();
//   render(probe.wrap("composer", <Composer />));
//   probe.reset();
//   await user.type(input, "hello");
//   probe.assertRenderBudget({ composer: 3, transcript: 0 });
//
// This module is test-only infrastructure. It must not be exported from the
// package public entry points.

export interface RenderBudgetProbe {
  /** Wrap a component subtree so its React commits are counted under `id`. */
  wrap(id: string, node: ReactNode): ReactNode;
  /** Commits observed for `id` since creation or the last `reset()`. */
  renderCount(id: string): number;
  /** Zero all counters, typically right before the measured interaction. */
  reset(): void;
  /**
   * Assert an upper bound of commits per probe id. Ids wrapped but not listed
   * are ignored; listing an id that was never wrapped fails the assertion so
   * budgets cannot silently rot when components are renamed.
   */
  assertRenderBudget(budgetByProbeId: Record<string, number>): void;
}

export function createRenderBudgetProbe(): RenderBudgetProbe {
  const commitCountByProbeId = new Map<string, number>();
  const wrappedProbeIds = new Set<string>();

  const handleRender = (id: string) => {
    commitCountByProbeId.set(id, (commitCountByProbeId.get(id) ?? 0) + 1);
  };

  return {
    assertRenderBudget(budgetByProbeId) {
      const failures: string[] = [];
      for (const [id, budget] of Object.entries(budgetByProbeId)) {
        if (!wrappedProbeIds.has(id)) {
          failures.push(
            `probe "${id}" is asserted but was never wrapped; update the budget test to match the component tree`
          );
          continue;
        }
        const count = commitCountByProbeId.get(id) ?? 0;
        if (count > budget) {
          failures.push(
            `probe "${id}" rendered ${count} time(s), budget is ${budget}`
          );
        }
      }
      if (failures.length > 0) {
        throw new Error(
          `render budget exceeded:\n${failures.map((line) => `- ${line}`).join("\n")}\n` +
            "Fix the subscription granularity at its source instead of raising the budget."
        );
      }
    },
    renderCount(id) {
      return commitCountByProbeId.get(id) ?? 0;
    },
    reset() {
      commitCountByProbeId.clear();
    },
    wrap(id, node) {
      wrappedProbeIds.add(id);
      return (
        <Profiler id={id} onRender={handleRender}>
          {node}
        </Profiler>
      );
    }
  };
}
