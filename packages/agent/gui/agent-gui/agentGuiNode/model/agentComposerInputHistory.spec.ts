import { describe, expect, it } from "vitest";
import {
  agentComposerDraftPrompt,
  buildAgentComposerDraft,
  emptyAgentComposerDraft
} from "./agentComposerDraft";
import {
  createAgentComposerInputHistoryStore,
  EMPTY_AGENT_COMPOSER_INPUT_HISTORY_STATE,
  navigateAgentComposerInputHistory,
  recordAgentComposerInputHistory
} from "./agentComposerInputHistory";

describe("agent composer input history", () => {
  it("records every non-empty submission made while the store is alive", () => {
    const store = createAgentComposerInputHistoryStore();
    const firstDraft = buildAgentComposerDraft({ prompt: "repeat" });

    expect(recordAgentComposerInputHistory(store, firstDraft)).toBe(true);
    expect(recordAgentComposerInputHistory(store, firstDraft)).toBe(true);
    expect(
      recordAgentComposerInputHistory(store, emptyAgentComposerDraft())
    ).toBe(false);

    firstDraft[0].text = "changed later";
    expect(store.entries.map((entry) => entry.id)).toEqual([
      "open:1",
      "open:2"
    ]);
    expect(
      store.entries.map((entry) => agentComposerDraftPrompt(entry.draft))
    ).toEqual(["repeat", "repeat"]);
  });

  it("navigates history from a non-empty draft and restores it after newest", () => {
    const entries = [
      { id: "one", draft: buildAgentComposerDraft({ prompt: "one" }) },
      { id: "two", draft: buildAgentComposerDraft({ prompt: "two" }) }
    ];
    const typedDraft = buildAgentComposerDraft({ prompt: "typing now" });
    const latest = navigateAgentComposerInputHistory({
      currentDraft: typedDraft,
      direction: "older",
      entries,
      state: EMPTY_AGENT_COMPOSER_INPUT_HISTORY_STATE
    });
    const older = navigateAgentComposerInputHistory({
      currentDraft: latest.draft!,
      direction: "older",
      entries,
      state: latest.state
    });
    const newer = navigateAgentComposerInputHistory({
      currentDraft: older.draft!,
      direction: "newer",
      entries,
      state: older.state
    });
    const current = navigateAgentComposerInputHistory({
      currentDraft: newer.draft!,
      direction: "newer",
      entries,
      state: newer.state
    });

    expect(agentComposerDraftPrompt(latest.draft!)).toBe("two");
    expect(agentComposerDraftPrompt(older.draft!)).toBe("one");
    expect(agentComposerDraftPrompt(newer.draft!)).toBe("two");
    expect(agentComposerDraftPrompt(current.draft!)).toBe("typing now");
    expect(current.state).toBe(EMPTY_AGENT_COMPOSER_INPUT_HISTORY_STATE);
  });

  it("restores an empty current draft after moving past the newest entry", () => {
    const entry = {
      id: "one",
      draft: buildAgentComposerDraft({ prompt: "one" })
    };
    const recalled = navigateAgentComposerInputHistory({
      currentDraft: emptyAgentComposerDraft(),
      direction: "older",
      entries: [entry],
      state: EMPTY_AGENT_COMPOSER_INPUT_HISTORY_STATE
    });
    const current = navigateAgentComposerInputHistory({
      currentDraft: recalled.draft!,
      direction: "newer",
      entries: [entry],
      state: recalled.state
    });

    expect(agentComposerDraftPrompt(current.draft!)).toBe("");
  });

  it("treats an edited recalled entry as the new current draft", () => {
    const entries = [
      { id: "one", draft: buildAgentComposerDraft({ prompt: "one" }) },
      { id: "two", draft: buildAgentComposerDraft({ prompt: "two" }) }
    ];
    const recalled = navigateAgentComposerInputHistory({
      currentDraft: buildAgentComposerDraft({ prompt: "initial current" }),
      direction: "older",
      entries,
      state: EMPTY_AGENT_COMPOSER_INPUT_HISTORY_STATE
    });
    const restarted = navigateAgentComposerInputHistory({
      currentDraft: buildAgentComposerDraft({ prompt: "edited recall" }),
      direction: "older",
      entries,
      state: recalled.state
    });
    const current = navigateAgentComposerInputHistory({
      currentDraft: restarted.draft!,
      direction: "newer",
      entries,
      state: restarted.state
    });

    expect(agentComposerDraftPrompt(restarted.draft!)).toBe("two");
    expect(agentComposerDraftPrompt(current.draft!)).toBe("edited recall");
  });
});
