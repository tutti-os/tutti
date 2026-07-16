import assert from "node:assert/strict";
import test from "node:test";
import {
  buildMentionPaletteModel,
  buildMentionPaletteModelFromTriggerMatches,
  mentionPaletteExpandLabel,
  mentionPaletteGroup,
  moveMentionPaletteHighlight,
  nextMentionPaletteCategory,
  repairMentionPaletteHighlight,
  selectedMentionPaletteItem
} from "./mentionPaletteModel.ts";
import type { RichTextTriggerQueryMatch } from "../types/trigger.ts";

type Item = { key: string; label: string };
type MatchItem = { key: string; kind?: string };
type Match = RichTextTriggerQueryMatch<MatchItem>;

const categories = [
  { id: "members", label: "Members" },
  { id: "files", label: "Files" },
  { id: "tasks", label: "Tasks" }
] as const;

const getItemKey = (item: Item) => item.key;

test("mentionPaletteExpandLabel keeps the count fallback for transient states", () => {
  const group = { totalCount: 12, visibleCount: 10 };
  assert.equal(
    mentionPaletteExpandLabel({ ...group, expandStatus: "loading" }),
    "+2"
  );
  assert.equal(
    mentionPaletteExpandLabel({ ...group, expandStatus: "error" }),
    "+2"
  );
  assert.equal(
    mentionPaletteExpandLabel({ ...group, expandStatus: "idle" }),
    "+2"
  );
});

function makeMatch(
  providerId: string,
  key: string,
  item: MatchItem = { key }
): Match {
  return {
    providerId,
    trigger: "@",
    key,
    label: key,
    item,
    insertResult: { kind: "text", text: key }
  };
}

test("buildMentionPaletteModel creates a ready flat state from caller-owned groups", () => {
  const group = mentionPaletteGroup({
    id: "members",
    label: "Members",
    items: [{ key: "planner", label: "Planner" }]
  });
  const state = buildMentionPaletteModel({
    activeCategoryId: "members",
    categories,
    groups: [group],
    loading: false,
    query: "pla"
  });

  assert.equal(state.status, "ready");
  assert.equal(state.mode, "results");
  assert.equal(state.filter, "members");
  assert.deepEqual(state.categories, categories);
  assert.equal(state.groups[0], group);
});

test("moveMentionPaletteHighlight wraps item entries", () => {
  const state = buildMentionPaletteModel({
    activeCategoryId: "members",
    categories,
    groups: [
      mentionPaletteGroup({
        id: "members",
        items: [
          { key: "planner", label: "Planner" },
          { key: "critic", label: "Critic" }
        ]
      })
    ],
    loading: false
  });

  assert.equal(
    moveMentionPaletteHighlight({
      state,
      currentKey: null,
      delta: 1,
      getItemKey
    }),
    "members:planner"
  );
  assert.equal(
    moveMentionPaletteHighlight({
      state,
      currentKey: "members:planner",
      delta: -1,
      getItemKey
    }),
    "members:critic"
  );
});

test("moveMentionPaletteHighlight includes browse categories and expand entries", () => {
  const browseState = buildMentionPaletteModel<Item>({
    activeCategoryId: "members",
    categories,
    groups: [],
    loading: false,
    mode: "browse"
  });

  assert.equal(
    moveMentionPaletteHighlight({
      state: browseState,
      currentKey: null,
      delta: 1,
      getItemKey
    }),
    "category:members"
  );

  const resultState = buildMentionPaletteModel({
    activeCategoryId: "members",
    categories,
    groups: [
      {
        ...mentionPaletteGroup({
          id: "members",
          items: [{ key: "planner", label: "Planner" }]
        }),
        totalCount: 2,
        hasMore: true
      }
    ],
    loading: false
  });

  assert.equal(
    moveMentionPaletteHighlight({
      state: resultState,
      currentKey: "members:planner",
      delta: 1,
      getItemKey
    }),
    "expand:members"
  );
});

test("repairMentionPaletteHighlight keeps valid keys and otherwise chooses preferred or first entry", () => {
  const state = buildMentionPaletteModel({
    activeCategoryId: "members",
    categories,
    groups: [
      mentionPaletteGroup({
        id: "members",
        items: [
          { key: "planner", label: "Planner" },
          { key: "critic", label: "Critic" }
        ]
      })
    ],
    loading: false
  });

  assert.equal(
    repairMentionPaletteHighlight({
      state,
      currentKey: "members:critic",
      getItemKey
    }),
    "members:critic"
  );
  assert.equal(
    repairMentionPaletteHighlight({
      state,
      currentKey: "missing",
      preferredKey: "members:critic",
      getItemKey
    }),
    "members:critic"
  );
  assert.equal(
    repairMentionPaletteHighlight({
      state,
      currentKey: null,
      getItemKey
    }),
    "members:planner"
  );
});

test("selectedMentionPaletteItem resolves by flattened entry key", () => {
  const critic = { key: "critic", label: "Critic" };
  const state = buildMentionPaletteModel({
    activeCategoryId: "members",
    categories,
    groups: [
      mentionPaletteGroup({
        id: "members",
        items: [{ key: "planner", label: "Planner" }, critic]
      })
    ],
    loading: false
  });

  assert.equal(
    selectedMentionPaletteItem({
      state,
      key: "members:critic",
      getItemKey
    }),
    critic
  );

  assert.equal(
    selectedMentionPaletteItem({
      state,
      key: "members",
      getItemKey
    }),
    null
  );

  assert.equal(
    selectedMentionPaletteItem({
      state,
      key: null,
      getItemKey
    }),
    null
  );
});

test("nextMentionPaletteCategory wraps categories", () => {
  assert.equal(nextMentionPaletteCategory(categories, "members", -1), "tasks");
  assert.equal(nextMentionPaletteCategory(categories, "tasks", 1), "members");
});

test("buildMentionPaletteModelFromTriggerMatches applies category parent filters", () => {
  const file = makeMatch("file", "readme");
  const task = makeMatch("workspace-issue", "42");
  const state = buildMentionPaletteModelFromTriggerMatches({
    activeCategoryId: "files",
    categories: [
      {
        id: "files",
        label: "Files",
        providerIds: ["file"],
        matches: (match) => match.key.startsWith("read")
      }
    ],
    matches: [file, makeMatch("file", "notes"), task],
    loading: false
  });

  assert.equal(state.groups.length, 1);
  assert.equal(state.groups[0]?.id, "files");
  assert.deepEqual(state.groups[0]?.items, [file]);
});

test("buildMentionPaletteModelFromTriggerMatches assigns to the first matching section", () => {
  const pinned = makeMatch("file", "pinned", { key: "pinned", kind: "pinned" });
  const fallback = makeMatch("file", "fallback", {
    key: "fallback",
    kind: "pinned"
  });
  const state = buildMentionPaletteModelFromTriggerMatches({
    activeCategoryId: "files",
    categories: [
      {
        id: "files",
        label: "Files",
        providerIds: ["file"],
        sections: [
          {
            id: "pinned",
            label: "Pinned",
            matches: (match) => match.item.kind === "pinned"
          },
          {
            id: "all-files",
            label: "All files",
            providerIds: ["file"]
          }
        ]
      }
    ],
    matches: [pinned, fallback],
    loading: false
  });

  assert.equal(state.groups.length, 1);
  assert.equal(state.groups[0]?.id, "pinned");
  assert.deepEqual(state.groups[0]?.items, [pinned, fallback]);
});

test("buildMentionPaletteModelFromTriggerMatches drops section-unmatched matches", () => {
  const file = makeMatch("file", "readme");
  const session = makeMatch("agent-session", "session");
  const state = buildMentionPaletteModelFromTriggerMatches({
    activeCategoryId: "references",
    categories: [
      {
        id: "references",
        label: "References",
        sections: [
          {
            id: "files",
            providerIds: ["file"]
          }
        ]
      }
    ],
    matches: [file, session],
    loading: false
  });

  assert.equal(state.groups.length, 1);
  assert.deepEqual(state.groups[0]?.items, [file]);
});

test("buildMentionPaletteModelFromTriggerMatches supports implicit flat categories", () => {
  const member = makeMatch("participant", "ryan");
  const state = buildMentionPaletteModelFromTriggerMatches({
    activeCategoryId: "members",
    categories: [{ id: "members", label: "Members" }],
    matches: [member],
    loading: false
  });

  assert.equal(state.groups.length, 1);
  assert.equal(state.groups[0]?.id, "members");
  assert.equal(state.groups[0]?.label, undefined);
  assert.deepEqual(state.groups[0]?.items, [member]);
});

test("buildMentionPaletteModelFromTriggerMatches hides empty sections unless they define emptyLabel", () => {
  const state = buildMentionPaletteModelFromTriggerMatches({
    activeCategoryId: "members",
    categories: [
      {
        id: "members",
        label: "Members",
        sections: [
          { id: "agents", label: "Agents" },
          { id: "people", label: "People", emptyLabel: "No people" }
        ]
      }
    ],
    matches: [],
    loading: false
  });

  assert.equal(state.groups.length, 1);
  assert.equal(state.groups[0]?.id, "people");
  assert.equal(state.groups[0]?.emptyLabel, "No people");
});

test("buildMentionPaletteModelFromTriggerMatches preserves category, section, and match order", () => {
  const first = makeMatch("agent-session", "first");
  const second = makeMatch("file", "second");
  const third = makeMatch("file", "third");
  const state = buildMentionPaletteModelFromTriggerMatches({
    activeCategoryId: "references",
    categories: [
      { id: "members", label: "Members" },
      {
        id: "references",
        label: "References",
        sections: [
          { id: "sessions", providerIds: ["agent-session"] },
          { id: "files", providerIds: ["file"] }
        ]
      }
    ],
    matches: [second, first, third],
    loading: false
  });

  assert.deepEqual(
    state.categories.map((category) => category.id),
    ["members", "references"]
  );
  assert.deepEqual(
    state.groups.map((group) => group.id),
    ["sessions", "files"]
  );
  assert.deepEqual(state.groups[0]?.items, [first]);
  assert.deepEqual(state.groups[1]?.items, [second, third]);
});
