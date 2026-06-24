import assert from "node:assert/strict";
import test from "node:test";
import { renderMentionReferenceLeading } from "./mentionReferenceIcon.ts";
import {
  isMentionTriggerRowProviderId,
  richTextTriggerQueryMatchToMentionRowItem,
  workspaceAppIconFallbackUrlFromTriggerMatch
} from "./mentionTriggerRowItem.ts";
import type {
  RichTextTriggerInsertResult,
  RichTextTriggerQueryMatch
} from "../types/index.ts";

function match(
  overrides: Partial<RichTextTriggerQueryMatch> & {
    providerId: string;
  }
): RichTextTriggerQueryMatch {
  const { providerId, ...rest } = overrides;
  return {
    insertResult: mentionInsert("entity-1", overrides.label ?? "Label"),
    item: {},
    key: "entity-1",
    label: "Label",
    providerId,
    trigger: "@",
    ...rest
  };
}

function mentionInsert(
  entityId: string,
  label: string
): RichTextTriggerInsertResult {
  return {
    kind: "mention",
    mention: {
      entityId,
      label
    }
  };
}

test("maps workspace-app matches to app rows with optional tutti icon fallback", () => {
  const row = richTextTriggerQueryMatchToMentionRowItem(
    match({
      insertResult: {
        kind: "mention",
        mention: {
          entityId: "weather-app",
          label: "Weather",
          presentation: {
            description: "Forecasts and alerts"
          }
        }
      },
      key: "weather-key",
      label: "Weather",
      providerId: "workspace-app"
    }),
    {
      getWorkspaceAppIconFallbackUrl:
        workspaceAppIconFallbackUrlFromTriggerMatch
    }
  );

  assert.deepEqual(row, {
    kind: "app",
    description: "Forecasts and alerts",
    iconUrl: "tutti://workspace-apps/weather-app/icon.png",
    name: "Weather"
  });
  assert.equal(isMentionTriggerRowProviderId("workspace-app"), true);
  assert.equal(isMentionTriggerRowProviderId("unknown-provider"), false);
});

test("maps file matches with inferred image visual kind and icon thumbnail source", () => {
  const row = richTextTriggerQueryMatchToMentionRowItem(
    match({
      iconUrl: "asset://hero-thumb",
      insertResult: {
        kind: "markdown-link",
        href: "/workspace/src/hero.png",
        label: "hero.png"
      },
      item: { kind: "file" },
      key: "/workspace/src/hero.png",
      label: "hero.png",
      providerId: "file",
      subtitle: "/workspace/src/hero.png"
    })
  );

  assert.deepEqual(row, {
    kind: "file",
    childCountLabel: null,
    entryKind: "file",
    mentionNavigation: null,
    name: "hero.png",
    thumbnailUrl: "asset://hero-thumb",
    visualKind: "image"
  });
});

test("maps agent-session matches to session rows from display-ready presentation", () => {
  const row = richTextTriggerQueryMatchToMentionRowItem(
    match({
      insertResult: {
        kind: "mention",
        mention: {
          entityId: "session-1",
          label: "Fix login",
          presentation: {
            agentIconUrl: "asset://codex",
            description: "Investigating the OAuth callback",
            participant: "Ryan & Codex",
            statusDataStatus: "working",
            statusLabel: "Working",
            statusPulse: "true",
            userAvatarPlaceholderUrl: "asset://user-placeholder"
          }
        }
      },
      key: "session-1",
      label: "Fix login",
      providerId: "agent-session"
    })
  );

  assert.deepEqual(row, {
    kind: "session",
    agentIconUrl: "asset://codex",
    participant: "Ryan & Codex",
    statusTag: {
      dataStatus: "working",
      label: "Working",
      pulse: true,
      tone: "neutral",
      variant: "activity"
    },
    summary: "Investigating the OAuth callback",
    userAvatarPlaceholderUrl: "asset://user-placeholder",
    userAvatarUrl: null
  });
});

test("renderLeading override returns a plain row with caller-provided leading", () => {
  const row = richTextTriggerQueryMatchToMentionRowItem(
    match({
      insertResult: {
        kind: "mention",
        mention: {
          entityId: "issue-1",
          label: "Ship mention palette"
        }
      },
      key: "issue-1",
      label: "Ship mention palette",
      providerId: "workspace-issue"
    }),
    {
      getDescription: () => "Ryan",
      renderLeading: () => "custom-leading"
    }
  );

  assert.deepEqual(row, {
    kind: "plain",
    description: "Ryan",
    label: "Ship mention palette",
    leading: "custom-leading"
  });
});

test("standard reference leading uses a fixed 32px non-shrinking frame", () => {
  const leading = renderMentionReferenceLeading({
    kind: "workspace-issue",
    label: "A very long issue title"
  });

  assert.equal(
    leading.props["data-rich-text-at-mention-reference-leading"],
    "true"
  );
  assert.equal(leading.props.style.width, "32px");
  assert.equal(leading.props.style.height, "32px");
  assert.equal(leading.props.style.flex, "0 0 32px");
});
