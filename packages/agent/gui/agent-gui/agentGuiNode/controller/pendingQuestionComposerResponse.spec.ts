import { describe, expect, it } from "vitest";
import { resolvePendingQuestionComposerResponse } from "./pendingQuestionComposerResponse";

describe("resolvePendingQuestionComposerResponse", () => {
  it("maps the Composer instruction to every exact pending question safely", () => {
    const response = resolvePendingQuestionComposerResponse({
      activeTurnId: "turn-1",
      agentSessionId: "session-1",
      content: [{ type: "text", text: "  综合考虑并继续执行  " }],
      pendingInteractions: [
        {
          agentSessionId: "session-1",
          createdAtUnixMs: 1,
          input: {
            questions: [
              {
                allowFreeText: true,
                header: "First",
                id: "first",
                options: [],
                question: "First question?"
              },
              {
                allowFreeText: true,
                header: "Second",
                id: "__proto__",
                options: [],
                question: "Second question?"
              }
            ]
          },
          kind: "question",
          requestId: "request-1",
          status: "pending",
          turnId: "turn-1",
          updatedAtUnixMs: 1
        }
      ]
    });

    expect(response).toMatchObject({
      action: "submit",
      agentSessionId: "session-1",
      requestId: "request-1",
      turnId: "turn-1"
    });
    expect(response?.payload?.answers).toEqual([
      "综合考虑并继续执行",
      "综合考虑并继续执行"
    ]);
    const answersByQuestionId = response?.payload?.answersByQuestionId as
      | Record<string, string>
      | undefined;
    expect(answersByQuestionId?.first).toBe("综合考虑并继续执行");
    expect(answersByQuestionId?.__proto__).toBe("综合考虑并继续执行");
    expect(Object.hasOwn(answersByQuestionId ?? {}, "__proto__")).toBe(true);
  });

  it("fails closed unless one exact pending question accepts free text", () => {
    const input = {
      activeTurnId: "turn-1",
      agentSessionId: "session-1",
      content: [{ type: "text" as const, text: "Continue" }],
      pendingInteractions: [
        {
          agentSessionId: "session-1",
          createdAtUnixMs: 1,
          input: {
            questions: [
              {
                allowFreeText: true,
                header: "Scope",
                id: "scope",
                options: [],
                question: "Which scope?"
              }
            ]
          },
          kind: "question" as const,
          requestId: "request-1",
          status: "pending" as const,
          turnId: "turn-1",
          updatedAtUnixMs: 1
        }
      ]
    };
    const interaction = input.pendingInteractions[0]!;

    expect(
      resolvePendingQuestionComposerResponse({ ...input, content: [] })
    ).toBeNull();
    expect(
      resolvePendingQuestionComposerResponse({
        ...input,
        submitOptions: {
          capabilityRefs: [{ capability: "tutti", source: "slash_command" }]
        }
      })
    ).toBeNull();
    expect(
      resolvePendingQuestionComposerResponse({
        ...input,
        pendingInteractions: [
          interaction,
          { ...interaction, requestId: "request-2" }
        ]
      })
    ).toBeNull();
    expect(
      resolvePendingQuestionComposerResponse({
        ...input,
        pendingInteractions: [{ ...interaction, turnId: "turn-other" }]
      })
    ).toBeNull();
    expect(
      resolvePendingQuestionComposerResponse({
        ...input,
        pendingInteractions: [
          {
            ...interaction,
            input: {
              questions: [
                {
                  ...interaction.input!.questions![0],
                  allowFreeText: false
                }
              ]
            }
          }
        ]
      })
    ).toBeNull();
  });
});
