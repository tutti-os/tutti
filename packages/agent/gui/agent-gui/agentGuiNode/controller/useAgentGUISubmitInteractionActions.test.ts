import { expect, test } from "vitest";
import { typedGoalControlFromComposer } from "./useAgentGUISubmitInteractionActions.ts";

test("typed Goal semantics ignore presentation-only displayPrompt", () => {
  expect(
    typedGoalControlFromComposer(
      [{ type: "text", text: "/goal clear" }],
      "clear chip"
    )
  ).toEqual({ action: "clear" });
  expect(
    typedGoalControlFromComposer(
      [{ type: "text", text: "ordinary prompt" }],
      "/goal clear"
    )
  ).toBeNull();
});
