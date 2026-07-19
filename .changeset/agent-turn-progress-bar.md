---
"@tutti-os/agent-gui": minor
"@tutti-os/agent-activity-core": minor
"@tutti-os/claude-sdk-sidecar": minor
"@tutti-os/desktop": patch
---

Replace the "Planning next moves" processing row with a live per-turn progress bar in the agent transcript. The bar follows the active turn and shows the current model phase — waiting for response vs responding — with a per-phase elapsed timer anchored to real message/tool completion times, plus cumulative per-turn token counters (↑ input / ↓ output) for providers with the `tokenUsage` capability (Claude Code, Codex); providers without an input/output split show only the phase and timer. Token counters are accumulated daemon-side per turn (Claude: per-API-call input from `message_start` plus cumulative output deltas; Codex: thread-total baseline diffing including reasoning output) and flushed through turn transitions at ~1 Hz into the new durable `WorkspaceAgentTurn.tokenUsage` field.
