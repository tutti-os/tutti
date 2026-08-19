# Active Specs And Plans

This directory contains dated work that is still proposed or in progress. It
is intentionally small: completed plans are removed once their durable result
is represented by current architecture, conventions, ADRs, and tests. Git
history remains available for implementation archaeology.

Specs are not the source of truth for behavior that has already landed. When a
spec completes, update the current document that owns the result and delete the
dated plan.

There are currently eleven active specs:

- [Agent Provider Status Read/Detect Split](./2026-06-28-agent-status-read-detect-split-design.md): pending review.
- [Agent Extension Package Design](./2026-07-14-agent-extension-package-design.md): pending architecture and implementation approval.
- [Provider-Native Subagents](./2026-07-15-provider-native-subagents.md): accepted architecture, implementation in progress.
- [Agent Goal Control Design](./2026-07-15-agent-goal-control-design.md): implemented, pending final review and merge.
- [Mobile AgentGUI And DeviceLink Design](./2026-07-23-mobile-agentgui-device-link-design.md): accepted architecture; Android M0 transport slice passed, physical-network validation and M1+ remain active.
- [Agent Session Fork Design](./2026-07-27-agent-session-fork-design.md): throughTurn implemented; supersedes the 2026-07-01 draft and implementation plan.
- [Tutti Agent `skills/list` Integration](./2026-07-30-tutti-agent-skills-list-integration.md): implemented; local Desktop end-to-end validation passed, pending cross-platform artifact validation.
- [Agent Side Conversation Technical Design](./2026-07-28-agent-side-conversation-technical-design.md): runtime-only active-Turn Side architecture, provider contract, Codex reference flow, and delivery phases.
- [Connector Market Shared Domain](./2026-08-03-connector-market-shared-domain.md): signed shared core, Tutti daemon implementation host, and renderer service implemented; credential-backed connectors remain outside the initial compatibility boundary.
- [Agent Conversation Activity View PRD](./2026-08-05-agent-conversation-activity-view-prd.md): implemented, pending code review.
- [Connector Authorization UI Protocol](./2026-08-12-connector-authorization-interaction.md): accepted configuration-first protocol; protocol, declarative adapter, and replaceable renderer implementation in progress.
