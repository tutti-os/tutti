# PRD: AgentGUI First Message Loading Experience

## 1. Summary

This PRD defines how AgentGUI should behave after a user sends the first message in a new conversation. The product decision is to keep the user on the home composer while the new agent session is being created, then enter the conversation only after activation succeeds.

The goal is to avoid showing the internal "正在连接会话..." recovery banner during normal first-message creation. The homepage composer already has a send/busy state, so no extra "正在创建会话..." copy is required.

## 2. Contacts

| Name                        | Role           | Comment                                                             |
| --------------------------- | -------------- | ------------------------------------------------------------------- |
| Product                     | Product owner  | Owns the user flow and acceptance criteria.                         |
| AgentGUI Engineering        | Frontend owner | Owns AgentGUI controller, view model, and tests.                    |
| Desktop Runtime Engineering | Runtime owner  | Owns activity runtime, session creation, and event stream behavior. |
| Design                      | UX reviewer    | Reviews loading placement, copy, and empty states.                  |

## 3. Background

Previously, when a user sent the first message from the home composer, AgentGUI immediately created an optimistic conversation, switched into that conversation, and then started session activation.

Old chain:

```text
home composer submit
  -> startConversation
  -> create optimistic conversation
  -> switch into conversation detail
  -> activation.activate(mode="new")
  -> create workspace agent session
  -> runtime starts
  -> event stream updates transcript
```

That exposed activation as a bottom "正在连接会话..." banner inside the conversation flow. Users read this as a connection failure or stalled chat, especially when session creation is slow.

## 4. Objective

Make first-message creation feel stable and understandable:

- The user sends a prompt from the home composer.
- The app stays on the home composer while the session is being created.
- The existing send button busy state communicates that the submit is in progress.
- No separate "正在创建会话..." text is shown near the composer.
- No "正在连接会话..." banner is shown for normal first-message creation.
- The app enters the conversation only after activation succeeds.
- If activation fails, the user remains on the home composer, the draft is preserved, and the error is visible.

### Key Results

| Objective                 | Key Result                                                                                                                    |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Reduce confusing feedback | Normal first-message creation never shows "正在连接会话..." inside a conversation detail.                                     |
| Preserve user control     | The original draft remains available until session creation succeeds.                                                         |
| Avoid blank slow states   | The user stays in the stable first-create surface instead of entering an empty or partial conversation.                       |
| Preserve recovery clarity | Existing-session activation and retry can still show recovery UI when useful.                                                 |
| Prove correctness         | Add or update focused AgentGUI tests for pending creation, successful activation, failed activation, and remount persistence. |

## 5. User Segments

This is for users who start agent work from AgentGUI, especially:

- Users sending a first prompt from the home composer.
- Users who expect the UI to either keep their input or clearly enter a real chat.
- Users who may not understand the difference between session activation and runtime progress.

Constraints:

- AgentGUI must keep using `AgentActivityRuntime` as the source of truth.
- Runtime sequencing should not change for this UX fix.
- Existing-session recovery must remain visible because that is a real recovery state.
- The homepage should not gain new create-status copy for this flow.

## 6. Solution

### 6.1 First Message In A New Conversation

```text
User types prompt in home composer
  -> User presses send
  -> controller sets local isCreatingConversation
  -> home composer send button shows busy/disabled state
  -> activation.activate(mode="new")
  -> create workspace agent session
  -> activation succeeds
  -> controller creates/attaches conversation summary
  -> optimistic user message is recorded
  -> draft clears
  -> UI enters the conversation detail
  -> runtime events replace optimistic state
```

User-visible behavior:

- The page remains on the first-create/home composer while activation is pending.
- Do not show a blue recovery banner.
- Do not show extra lightweight text such as "正在创建会话...".
- The user cannot double-submit while `isCreatingConversation` is true.

### 6.2 Activation Takes Longer Than Expected

```text
User sends first prompt
  -> home composer stays visible
  -> send button remains busy
  -> no conversation detail is opened until activation succeeds
```

This avoids the current problem where an empty or partial conversation detail appears slowly and then shows recovery UI near the composer.

### 6.3 Activation Succeeds

```text
activation returns attached/active session
  -> attach created conversation
  -> record the submitted prompt as the first optimistic user message
  -> clear the draft
  -> persist active conversation id
  -> load messages/state and sync list projection
```

The first conversation render should already contain the submitted user message.

### 6.4 Activation Fails

```text
activation throws or returns failed
  -> clear create pending state
  -> stay on home composer
  -> preserve draft
  -> show error on the home surface
  -> do not create a failed conversation detail for a session that did not attach
```

This makes retry straightforward because the user's original input remains editable.

### 6.5 Existing Session Recovery

```text
User opens or retries an existing session
  -> activation.activate(mode="existing")
  -> recovery UI can show while activating
  -> failed recovery can show retry/continue actions
```

This flow can keep "正在连接会话..." because the user is actually trying to reconnect to an existing session.

## 7. Technical Scope

Likely files:

- `packages/agent/gui/agent-gui/agentGuiNode/controller/useAgentGUINodeController.ts`
- `packages/agent/gui/agent-gui/agentGuiNode/controller/useAgentGUINodeController.spec.tsx`
- `docs/architecture/agent-gui-node.md`

Implementation rules:

- Do not set `activeConversationId` during first-create activation pending.
- Do not set transient conversation or session message loading before activation succeeds.
- Do not record the optimistic user message before activation succeeds.
- Keep `isCreatingConversation` as the home composer busy/submit guard.
- Clear the draft only after successful activation and attach.
- On activation failure, keep the home composer and preserve the draft.
- Continue using pending-create shared state so remounts know a first-create operation is in flight.

## 8. Release

### Version 1

Scope:

- Keep homepage visible during first-message session creation.
- Rely on the existing composer busy/send-button state.
- Remove normal first-create exposure of "正在连接会话...".
- Enter conversation only after activation succeeds.
- Preserve draft and show error on activation failure.
- Keep existing-session recovery behavior unchanged.
- Add/update focused controller tests.

Expected effort: small to medium.

### Future

Scope:

- Add telemetry for time from send click to activation resolved and first runtime event.
- Revisit global AgentGUI loading copy so each state maps to a user job rather than an internal implementation phase.
