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
  assert.match(compiled, /nextHostActions\.onAgentConfigMenuOpen/);
  assert.match(compiled, /nextHostActions\.onOpenConversationWindow/);
  assert.match(compiled, /nextRenderSlots\.agentConfigAccount/);
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

test("forwards the host-owned composer footer accessory slot", () => {
  const composerFooterAccessory = () => null;
  const result = useStableDesktopAgentGUIHostProps({
    hostActions: {},
    hostCapabilities: {},
    identity: { currentUserId: null, nodeId: "node-1", workspaceId: "ws-1" },
    renderSlots: { composerFooterAccessory },
    runtimeRequests: {},
    workspace: {}
  } as never);

  assert.strictEqual(
    result.renderSlots.composerFooterAccessory,
    composerFooterAccessory
  );
});

test("forwards the live conversation rail layout signal", () => {
  const onConversationRailLayoutChange = () => {};
  const result = useStableDesktopAgentGUIHostProps({
    hostActions: { onConversationRailLayoutChange },
    hostCapabilities: {},
    identity: { currentUserId: null, nodeId: "node-1", workspaceId: "ws-1" },
    renderSlots: {},
    runtimeRequests: {},
    workspace: {}
  } as never);

  assert.strictEqual(
    result.hostActions.onConversationRailLayoutChange,
    onConversationRailLayoutChange
  );
});

test("forwards every runtimeRequests field instead of silently dropping new ones", () => {
  // The manual field-keyed reconstruction below is exactly the pattern that
  // let an optional host request silently vanish. This test round-trips every
  // runtimeRequests field so a future
  // field added upstream but forgotten here fails loudly instead of
  // shipping a menu action that does nothing.
  const runtimeRequests = {
    agentStatusController: { controller: "value" },
    composerAppend: { text: "hi" },
    composerFocusSequence: 1,
    openSession: { agentSessionId: "session-1" },
    prefillPrompt: { prompt: "hi" },
    workbench: {
      instanceId: "instance-1",
      onConversationRailToggle: () => {}
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
