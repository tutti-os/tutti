import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import reactCompiler from "babel-plugin-react-compiler";
import { useStableDesktopAgentGUIHostProps } from "./useStableDesktopAgentGUIHostProps.ts";

const require = createRequire(import.meta.url);
const { transformAsync } = require("@babel/core") as {
  transformAsync: (
    source: string,
    options: Record<string, unknown>
  ) => Promise<{ code?: string | null } | null>;
};

const sourceUrl = new URL(
  "./useStableDesktopAgentGUIHostProps.ts",
  import.meta.url
);

test("React Compiler preserves field-keyed Agent GUI host projections", async () => {
  const source = await readFile(sourceUrl, "utf8");
  const result = await transformAsync(source, {
    babelrc: false,
    configFile: false,
    filename: sourceUrl.pathname,
    parserOpts: { plugins: ["typescript"] },
    plugins: [
      [
        reactCompiler,
        {
          compilationMode: "infer",
          panicThreshold: "none"
        }
      ]
    ]
  });
  const compiled = result?.code ?? "";

  assert.doesNotMatch(compiled, /const identity\w* = nextIdentity;/);
  assert.match(compiled, /nextIdentity\.nodeId/);
  assert.match(compiled, /nextIdentity\.workspaceId/);
  assert.match(compiled, /nextWorkspace\.fileReferenceAdapter/);
  assert.match(compiled, /nextWorkspace\.selectProjectDirectory/);
  assert.match(compiled, /nextHostActions\.onOpenConversationWindow/);
});

test("forwards the explicitly selected project directory capability", () => {
  const selectProjectDirectory = async () => ({ path: "/workspace/project" });
  const result = useStableDesktopAgentGUIHostProps({
    hostActions: {},
    hostCapabilities: {},
    identity: { currentUserId: null, nodeId: "node-1", workspaceId: "ws-1" },
    renderSlots: {},
    runtimeRequests: {},
    workspace: { selectProjectDirectory }
  } as never);

  assert.strictEqual(
    result.workspace.selectProjectDirectory,
    selectProjectDirectory
  );
});

test("forwards every runtimeRequests field instead of silently dropping new ones", () => {
  // The manual field-keyed reconstruction below is exactly the pattern that
  // let `sessionAction` silently vanish (dropped this exact way, then wired
  // through the host chrome's dispatch->window-event->hook chain with no
  // effect and no error, since the field is optional so TS never caught
  // it). This test round-trips every runtimeRequests field so a future
  // field added upstream but forgotten here fails loudly instead of
  // shipping a menu action that does nothing.
  const runtimeRequests = {
    agentStatusController: { controller: "value" },
    composerAppend: { text: "hi" },
    composerFocusSequence: 1,
    newConversationSequence: 2,
    openSession: { agentSessionId: "session-1" },
    prefillPrompt: { prompt: "hi" },
    sessionAction: {
      action: "copy-markdown",
      agentSessionId: null,
      sequence: 1
    }
  };

  const result = useStableDesktopAgentGUIHostProps({
    hostActions: {},
    hostCapabilities: {},
    identity: { currentUserId: null, nodeId: "node-1", workspaceId: "ws-1" },
    renderSlots: {},
    runtimeRequests,
    workspace: {}
  } as never);

  for (const key of Object.keys(runtimeRequests)) {
    assert.strictEqual(
      (result.runtimeRequests as Record<string, unknown>)[key],
      (runtimeRequests as Record<string, unknown>)[key],
      `runtimeRequests.${key} must be forwarded`
    );
  }
});
