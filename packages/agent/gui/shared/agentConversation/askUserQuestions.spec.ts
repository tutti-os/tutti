import { describe, expect, it } from "vitest";
import { normalizeAskUserQuestions } from "./askUserQuestions";

describe("normalizeAskUserQuestions", () => {
  it("maps header / question / options and defaults multiSelect to false", () => {
    expect(
      normalizeAskUserQuestions([
        {
          id: "plan-kind",
          header: "Plan topic",
          question: "Which kind of plan?",
          options: [
            { label: "Health check", description: "Audit the repo" },
            { label: "Feature plan" }
          ]
        }
      ])
    ).toEqual([
      {
        id: "plan-kind",
        header: "Plan topic",
        question: "Which kind of plan?",
        options: [
          { label: "Health check", description: "Audit the repo" },
          { label: "Feature plan", description: "" }
        ],
        multiSelect: false
      }
    ]);
  });

  it("defaults id/header/question and drops option entries without a label", () => {
    expect(
      normalizeAskUserQuestions([
        { options: [{ description: "no label" }, { label: "Keep" }] }
      ])
    ).toEqual([
      {
        id: "question-1",
        header: "Question 1",
        question: "Question 1",
        options: [{ label: "Keep", description: "" }],
        multiSelect: false
      }
    ]);
  });

  it("falls back to the header for the question text and carries multiSelect", () => {
    expect(
      normalizeAskUserQuestions([
        { id: "q", header: "Pick some", multiSelect: true }
      ])
    ).toEqual([
      {
        id: "q",
        header: "Pick some",
        question: "Pick some",
        options: [],
        multiSelect: true
      }
    ]);
  });

  it("preserves an option-only answer surface", () => {
    expect(
      normalizeAskUserQuestions([
        {
          id: "question-1",
          question: "Pick one",
          options: [{ label: "A" }],
          allowFreeText: false
        }
      ])
    ).toEqual([
      {
        id: "question-1",
        header: "Question 1",
        question: "Pick one",
        options: [{ label: "A", description: "" }],
        multiSelect: false,
        allowFreeText: false
      }
    ]);
  });

  it("ignores non-array input and non-object entries", () => {
    expect(normalizeAskUserQuestions(null)).toEqual([]);
    expect(normalizeAskUserQuestions("nope")).toEqual([]);
    expect(normalizeAskUserQuestions([null, 42, "x"])).toEqual([]);
  });
});
