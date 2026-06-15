import { describe, expect, it } from "vitest";
import { buildAskUserAnswerPayload } from "./interactiveAnswerPayload";

describe("buildAskUserAnswerPayload", () => {
  it("keeps the keyed map and derives a flat display list from it", () => {
    expect(buildAskUserAnswerPayload({ "plan-kind": "Health check" })).toEqual({
      answers: ["Health check"],
      answersByQuestionId: { "plan-kind": "Health check" }
    });
  });

  it("joins multi-select values for the display list only", () => {
    expect(
      buildAskUserAnswerPayload({
        scope: "Renderer",
        areas: ["A", "B"]
      })
    ).toEqual({
      answers: ["Renderer", "A, B"],
      answersByQuestionId: { scope: "Renderer", areas: ["A", "B"] }
    });
  });
});
