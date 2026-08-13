import { describe, expect, it } from "vitest";
import {
  buildAskUserComposerAnswerPayload,
  buildAskUserAnswerPayload,
  readOwnAnswer,
  writeOwnAnswer
} from "./interactiveAnswerPayload";

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

  it("reads and writes provider question ids as own properties", () => {
    const answers: Record<string, string> = {};
    writeOwnAnswer(answers, "__proto__", "first");
    writeOwnAnswer(answers, "constructor", "second");

    expect(readOwnAnswer(answers, "__proto__", "")).toBe("first");
    expect(readOwnAnswer(answers, "constructor", "")).toBe("second");
    expect(Object.hasOwn(answers, "__proto__")).toBe(true);
    expect(Object.hasOwn(answers, "constructor")).toBe(true);
  });

  it("maps one composer instruction to every question without unsafe keys", () => {
    const payload = buildAskUserComposerAnswerPayload(
      ["first", "__proto__", "first", "  second  "],
      "  综合考虑并继续执行  "
    );

    expect(payload?.answers).toEqual([
      "综合考虑并继续执行",
      "综合考虑并继续执行",
      "综合考虑并继续执行"
    ]);
    expect(payload?.answersByQuestionId.first).toBe("综合考虑并继续执行");
    expect(payload?.answersByQuestionId.second).toBe("综合考虑并继续执行");
    expect(payload?.answersByQuestionId.__proto__).toBe("综合考虑并继续执行");
    expect(Object.hasOwn(payload?.answersByQuestionId ?? {}, "__proto__")).toBe(
      true
    );
  });

  it("rejects empty composer answers and missing question identities", () => {
    expect(buildAskUserComposerAnswerPayload(["question"], "   ")).toBeNull();
    expect(
      buildAskUserComposerAnswerPayload(["", "   "], "continue")
    ).toBeNull();
  });
});
