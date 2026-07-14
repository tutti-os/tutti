import { describe, expect, it } from "vitest";
import {
  buildAgentComposerDraft,
  snapshotAgentComposerDraft
} from "../model/agentComposerDraft";
import type { SubmittedDraftSnapshot } from "../model/agentGuiNodeTypes";
import {
  areAgentComposerDraftsEqual,
  clearSubmittedDraftIfUnchanged,
  deleteSubmittedDraftSnapshotsForScopes,
  deleteUnacceptedSubmittedDraftSnapshot
} from "./agentGuiController.draftMessageHelpers";

describe("submitted composer draft cleanup", () => {
  const sourceScopeKey = "session:session-1";
  const submittedDraft = buildAgentComposerDraft({
    prompt: "Review this",
    images: [
      {
        id: "image-1",
        name: "screen.png",
        mimeType: "image/png",
        attachmentId: "attachment-1",
        previewUrl: "blob:image-1"
      }
    ],
    files: [
      {
        id: "file-1",
        name: "notes.md",
        path: "/workspace/notes.md"
      }
    ],
    largeTexts: [
      {
        id: "paste-1",
        name: "pasted-text.txt",
        text: "large pasted body",
        path: "/archive/paste-1.txt"
      }
    ]
  });
  const snapshot: SubmittedDraftSnapshot = {
    sourceScopeKey,
    content: snapshotAgentComposerDraft(submittedDraft)
  };

  it("clears the entire source scope when its full content still matches", () => {
    const drafts = { [sourceScopeKey]: submittedDraft };
    const result = clearSubmittedDraftIfUnchanged({ drafts, snapshot });

    expect(result).not.toBe(drafts);
    expect(result[sourceScopeKey]).toEqual([{ type: "text", text: "" }]);
  });

  it("retains the entire current draft when text changes during submission", () => {
    const editedDraft = buildAgentComposerDraft({
      prompt: "Review this and the follow-up",
      images: [
        {
          id: "image-1",
          name: "screen.png",
          mimeType: "image/png",
          attachmentId: "attachment-1",
          previewUrl: "blob:image-1"
        }
      ]
    });
    const drafts = { [sourceScopeKey]: editedDraft };

    expect(clearSubmittedDraftIfUnchanged({ drafts, snapshot })).toBe(drafts);
  });

  it("treats attachment upload metadata as part of the atomic content", () => {
    const current = snapshotAgentComposerDraft(submittedDraft);
    const image = current.find((block) => block.type === "image");
    if (image) image.uploading = true;

    expect(areAgentComposerDraftsEqual(current, submittedDraft)).toBe(false);
    const drafts = { [sourceScopeKey]: current };
    expect(clearSubmittedDraftIfUnchanged({ drafts, snapshot })).toBe(drafts);
  });

  it("compares newly-added block metadata without maintaining a field list", () => {
    const current = snapshotAgentComposerDraft(submittedDraft);
    const image = current.find((block) => block.type === "image");
    Object.assign(image ?? {}, { futureMetadata: "edited" });

    expect(areAgentComposerDraftsEqual(current, submittedDraft)).toBe(false);
  });

  it("does not clear a different project or session scope", () => {
    const otherScopeKey = "session:session-2";
    const drafts = {
      [sourceScopeKey]: submittedDraft,
      [otherScopeKey]: buildAgentComposerDraft({ prompt: "Keep me" })
    };

    const result = clearSubmittedDraftIfUnchanged({ drafts, snapshot });
    expect(result[otherScopeKey]).toBe(drafts[otherScopeKey]);
  });

  it("deletes unresolved snapshots owned by deleted scopes only", () => {
    const snapshots: Record<string, SubmittedDraftSnapshot> = {
      "submit-1": snapshot,
      "submit-2": {
        sourceScopeKey: "session:session-2",
        content: buildAgentComposerDraft({ prompt: "Keep me" })
      },
      "submit-3": {
        sourceScopeKey: "project:/workspace/recovered",
        targetAgentSessionId: "session-1",
        content: buildAgentComposerDraft({ prompt: "Recovered draft" })
      }
    };

    deleteSubmittedDraftSnapshotsForScopes({
      snapshots,
      scopeKeys: new Set([sourceScopeKey]),
      targetAgentSessionIds: new Set(["session-1"])
    });

    expect(snapshots).toEqual({
      "submit-2": {
        sourceScopeKey: "session:session-2",
        content: buildAgentComposerDraft({ prompt: "Keep me" })
      }
    });
  });

  it("drops a snapshot immediately when the engine rejects the submit", () => {
    const snapshots = { "submit-1": snapshot };

    deleteUnacceptedSubmittedDraftSnapshot({
      snapshots,
      clientSubmitId: "submit-1",
      accepted: false,
      queued: false
    });

    expect(snapshots).toEqual({});
  });

  it("keeps a snapshot while an accepted submit is pending", () => {
    const snapshots = { "submit-1": snapshot };

    deleteUnacceptedSubmittedDraftSnapshot({
      snapshots,
      clientSubmitId: "submit-1",
      accepted: true,
      queued: false
    });

    expect(snapshots["submit-1"]).toBe(snapshot);
  });
});
