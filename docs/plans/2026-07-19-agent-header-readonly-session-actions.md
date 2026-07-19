# Agent Header Read-Only Session Actions

## Goal

Let read-only host surfaces reuse the complete `AgentGuiWorkbenchHeader` while exposing only the session actions they can support. TSH Activity Center is the first consumer: it needs the canonical session title, Agent icon, copy-as-Markdown, copy-as-reference, and its host-owned close action, but it must not offer rename.

## Design

- `AgentGuiWorkbenchHeader` accepts an optional `sessionMenuActions` list.
- Omitting the list preserves the existing rename and copy menu.
- The shared menu renders only declared actions and emits separators only between visible action groups.
- The existing `agent-conversation` entrypoint exports the pure transcript serializer so external read-only conversation surfaces can preserve AgentGUI's Markdown format without copying implementation.
- Hosts retain ownership of canonical session/message loading, clipboard access, toasts, and window actions.

## Invariants

1. Existing AgentGUI headers keep their current menu when no capability list is supplied.
2. A read-only host cannot expose rename when it declares only copy actions.
3. Session identity comes from the host's canonical session projection; menu availability never changes the title.

## Verification

- Shared menu component tests for default and copy-only action sets.
- Agent GUI package typecheck and packed-surface validation.
- TSH Activity Center tests for shared title, menu contents, Markdown copy, reference copy, and close behavior.
