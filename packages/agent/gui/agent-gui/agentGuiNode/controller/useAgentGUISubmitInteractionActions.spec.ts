import { describe, expect, it } from "vitest";
import type { AgentComposerDraft } from "../model/agentGuiNodeTypes";
import { agentComposerDraftPrompt } from "../model/agentComposerDraft";
import {
  clearSubmittedAgentGUIHomeDraft,
  restoreFailedAgentGUIHomeDraft
} from "./agentGuiController.homeDraftHelpers";

const draftKey = "node-default:codex:local:codex";

function draft(prompt: string): AgentComposerDraft {
  return [{ type: "text", text: prompt }];
}

describe("new-conversation home draft lifecycle", () => {
  it("clears only the draft that still matches the submitted content", () => {
    const submitted = draft("first");
    const matching = { [draftKey]: draft("first") };
    const changed = { [draftKey]: draft("second") };

    expect(
      agentComposerDraftPrompt(
        clearSubmittedAgentGUIHomeDraft({
          draftKey,
          drafts: matching,
          submittedDraft: submitted
        })[draftKey]!
      )
    ).toBe("");
    expect(
      clearSubmittedAgentGUIHomeDraft({
        draftKey,
        drafts: changed,
        submittedDraft: submitted
      })
    ).toBe(changed);
  });

  it("restores a failed activation only when the home draft is still empty", () => {
    const empty = { [draftKey]: draft("") };
    const changed = { [draftKey]: draft("second") };
    const failure = {
      agentSessionId: "session-1",
      content: [{ type: "text" as const, text: "first" }],
      draftKey
    };

    expect(
      agentComposerDraftPrompt(
        restoreFailedAgentGUIHomeDraft({ ...failure, drafts: empty })[draftKey]!
      )
    ).toBe("first");
    expect(
      restoreFailedAgentGUIHomeDraft({ ...failure, drafts: changed })
    ).toBe(changed);
  });
});
