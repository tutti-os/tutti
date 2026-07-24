package runtimeprep

import (
	"errors"
	"fmt"
	"strings"
)

type AgentSessionContextMode string

const (
	AgentSessionContextProgressiveGet  AgentSessionContextMode = "progressive-get"
	AgentSessionContextSummaryAndState AgentSessionContextMode = "session-summary-and-state"
)

type AgentTurnResourcesMode string

const (
	AgentTurnResourcesLocalPath   AgentTurnResourcesMode = "local-path"
	AgentTurnResourcesReadPath    AgentTurnResourcesMode = "read-path"
	AgentTurnResourcesUnavailable AgentTurnResourcesMode = "unavailable"
)

type AgentCancellationMode string

const (
	AgentCancellationTurn    AgentCancellationMode = "turn"
	AgentCancellationSession AgentCancellationMode = "session"
)

type AgentInteractionResponseMode string

const (
	AgentInteractionResponseCommand     AgentInteractionResponseMode = "command"
	AgentInteractionResponseUnavailable AgentInteractionResponseMode = "unavailable"
)

type AgentWorkspaceScopeMode string

const (
	AgentWorkspaceScopeEnvironment AgentWorkspaceScopeMode = "workspace-environment"
	AgentWorkspaceScopeRoom        AgentWorkspaceScopeMode = "room"
)

type AgentTargetContinuationMode string

const (
	AgentTargetContinuationAll            AgentTargetContinuationMode = "all"
	AgentTargetContinuationExceptPrefixes AgentTargetContinuationMode = "except-prefixes"
)

type AgentTargetContinuationProfile struct {
	Mode                        AgentTargetContinuationMode
	UnsupportedTargetIDPrefixes []string
}

// AgentWorkflowProfile describes the agent CLI behavior exposed by one host.
// It is intentionally modeled with enums rather than independent feature
// booleans so generated skills always select one coherent workflow per concern.
type AgentWorkflowProfile struct {
	SessionContext      AgentSessionContextMode
	TurnResources       AgentTurnResourcesMode
	Cancellation        AgentCancellationMode
	InteractionResponse AgentInteractionResponseMode
	WorkspaceScope      AgentWorkspaceScopeMode
	TargetContinuation  AgentTargetContinuationProfile
}

func DefaultAgentWorkflowProfile() AgentWorkflowProfile {
	return AgentWorkflowProfile{
		SessionContext:      AgentSessionContextProgressiveGet,
		TurnResources:       AgentTurnResourcesLocalPath,
		Cancellation:        AgentCancellationTurn,
		InteractionResponse: AgentInteractionResponseCommand,
		WorkspaceScope:      AgentWorkspaceScopeEnvironment,
		TargetContinuation: AgentTargetContinuationProfile{
			Mode: AgentTargetContinuationAll,
		},
	}
}

func normalizeAgentWorkflowProfile(profile AgentWorkflowProfile) (AgentWorkflowProfile, error) {
	defaults := DefaultAgentWorkflowProfile()
	if profile.SessionContext == "" {
		profile.SessionContext = defaults.SessionContext
	}
	if profile.TurnResources == "" {
		profile.TurnResources = defaults.TurnResources
	}
	if profile.Cancellation == "" {
		profile.Cancellation = defaults.Cancellation
	}
	if profile.InteractionResponse == "" {
		profile.InteractionResponse = defaults.InteractionResponse
	}
	if profile.WorkspaceScope == "" {
		profile.WorkspaceScope = defaults.WorkspaceScope
	}
	if profile.TargetContinuation.Mode == "" {
		profile.TargetContinuation.Mode = defaults.TargetContinuation.Mode
	}
	if profile.SessionContext != AgentSessionContextProgressiveGet &&
		profile.SessionContext != AgentSessionContextSummaryAndState {
		return AgentWorkflowProfile{}, fmt.Errorf("unknown agent session context mode %q", profile.SessionContext)
	}
	if profile.TurnResources != AgentTurnResourcesLocalPath &&
		profile.TurnResources != AgentTurnResourcesReadPath &&
		profile.TurnResources != AgentTurnResourcesUnavailable {
		return AgentWorkflowProfile{}, fmt.Errorf("unknown agent turn resources mode %q", profile.TurnResources)
	}
	if profile.Cancellation != AgentCancellationTurn &&
		profile.Cancellation != AgentCancellationSession {
		return AgentWorkflowProfile{}, fmt.Errorf("unknown agent cancellation mode %q", profile.Cancellation)
	}
	if profile.InteractionResponse != AgentInteractionResponseCommand &&
		profile.InteractionResponse != AgentInteractionResponseUnavailable {
		return AgentWorkflowProfile{}, fmt.Errorf("unknown agent interaction response mode %q", profile.InteractionResponse)
	}
	if profile.WorkspaceScope != AgentWorkspaceScopeEnvironment &&
		profile.WorkspaceScope != AgentWorkspaceScopeRoom {
		return AgentWorkflowProfile{}, fmt.Errorf("unknown agent workspace scope mode %q", profile.WorkspaceScope)
	}
	if profile.TargetContinuation.Mode != AgentTargetContinuationAll &&
		profile.TargetContinuation.Mode != AgentTargetContinuationExceptPrefixes {
		return AgentWorkflowProfile{}, fmt.Errorf("unknown agent target continuation mode %q", profile.TargetContinuation.Mode)
	}
	profile.TargetContinuation.UnsupportedTargetIDPrefixes = normalizedTargetIDPrefixes(
		profile.TargetContinuation.UnsupportedTargetIDPrefixes,
	)
	if profile.TargetContinuation.Mode == AgentTargetContinuationAll &&
		len(profile.TargetContinuation.UnsupportedTargetIDPrefixes) > 0 {
		return AgentWorkflowProfile{}, errors.New("agent target continuation mode all cannot exclude target id prefixes")
	}
	if profile.TargetContinuation.Mode == AgentTargetContinuationExceptPrefixes &&
		len(profile.TargetContinuation.UnsupportedTargetIDPrefixes) == 0 {
		return AgentWorkflowProfile{}, errors.New("agent target continuation except-prefixes requires at least one target id prefix")
	}
	return profile, nil
}

func normalizedTargetIDPrefixes(prefixes []string) []string {
	seen := make(map[string]struct{}, len(prefixes))
	normalized := make([]string, 0, len(prefixes))
	for _, prefix := range prefixes {
		prefix = strings.TrimSpace(prefix)
		if prefix == "" {
			continue
		}
		if _, ok := seen[prefix]; ok {
			continue
		}
		seen[prefix] = struct{}{}
		normalized = append(normalized, prefix)
	}
	return normalized
}

func isDefaultAgentWorkflowProfile(profile AgentWorkflowProfile) bool {
	defaults := DefaultAgentWorkflowProfile()
	return profile.SessionContext == defaults.SessionContext &&
		profile.TurnResources == defaults.TurnResources &&
		profile.Cancellation == defaults.Cancellation &&
		profile.InteractionResponse == defaults.InteractionResponse &&
		profile.WorkspaceScope == defaults.WorkspaceScope &&
		profile.TargetContinuation.Mode == defaults.TargetContinuation.Mode &&
		len(profile.TargetContinuation.UnsupportedTargetIDPrefixes) == 0
}

func resolvedAgentWorkflow(input PrepareInput) AgentWorkflowProfile {
	if input.resolved != nil {
		return input.resolved.AgentWorkflow
	}
	if hasAgentWorkflowProfile(input.agentWorkflow) {
		return input.agentWorkflow
	}
	return DefaultAgentWorkflowProfile()
}

func hasAgentWorkflowProfile(profile AgentWorkflowProfile) bool {
	return profile.SessionContext != "" ||
		profile.TurnResources != "" ||
		profile.Cancellation != "" ||
		profile.InteractionResponse != "" ||
		profile.WorkspaceScope != "" ||
		profile.TargetContinuation.Mode != "" ||
		len(profile.TargetContinuation.UnsupportedTargetIDPrefixes) > 0
}

func agentRouteFirstGuidance(input PrepareInput) string {
	if resolvedAgentWorkflow(input).SessionContext == AgentSessionContextSummaryAndState {
		return "3. Agent work uses only `agent ...`. Handoff decisions — who executes, which task to hand off, and where follow-ups go — belong to `$tutti-handoff`; use this skill as its CLI reference. Before starting a new agent session, query `agent list --json` and select an exact agent id from the current catalog rather than assuming which providers exist. For `mention://agent-session/<sessionId>?workspaceId=...`, prefer `agent wait --session-id <session-id> --json` for the next stop point, use `agent session-summary --session-id <session-id> --json` for conversation recovery, and use `agent get --session-id <session-id> --json` only for session state."
	}
	return "3. Agent work uses only `agent ...`. Handoff decisions — who executes, which task to hand off, and where follow-ups go — belong to `$tutti-handoff`; use this skill as its CLI reference. Before starting a new agent session, query `agent list --json` and select an exact agent id from the current catalog rather than assuming which providers exist. For `mention://agent-session/<sessionId>?workspaceId=...`, prefer `agent wait --session-id <session-id> --json` to block until the session's next stop point without fetching execution messages. Use `agent get --session-id <session-id> --json` only when you need recent conversation context, and add `--view turns` when only Turn ids or metadata are needed."
}

func agentSessionMentionGuidance(input PrepareInput) string {
	command := normalizeCLICommandName(input.CLICommand)
	if resolvedAgentWorkflow(input).SessionContext == AgentSessionContextSummaryAndState {
		return "- `mention://agent-session/<sessionId>?workspaceId=...`: a context reference to an existing session, not a work order. Use `" + command + " agent wait --session-id <session-id> --json` to await its next stop point, `" + command + " agent session-summary --session-id <session-id> --json` to recover conversation messages, and `" + command + " agent get --session-id <session-id> --json` only for session state."
	}
	return "- `mention://agent-session/<sessionId>?workspaceId=...`: a context reference to an existing session, not a work order. Read it when its content helps the current turn — `agent wait --session-id <session-id> --json` to await its next stop point, `agent get --session-id <session-id> --json` for recent conversation recovery."
}

func agentSessionContextSkillGuidance(input PrepareInput) string {
	var guidance string
	if resolvedAgentWorkflow(input).SessionContext == AgentSessionContextSummaryAndState {
		guidance = strings.Join([]string{
			"- `agent get` is a state lookup in this host. It does not support progressive conversation views such as `--view turns` or `--view trace`. Use `agent session-summary` when the task needs messages.",
			"- `agent wait` blocks until the session's next stop point and does not fetch execution messages. Do not poll `agent get` or `agent session-summary` while a session is running.",
			"- Wait commands are single-call blocking operations. Invoke them once and let the CLI handle internal observation continuations; do not wrap them in a retry loop. Omit `--timeout-ms` to wait until a stop point. When an explicit total timeout expires, `timedOut: true` with `executionContinues: true` means only the local wait ended; the underlying session or run was not canceled.",
		}, "\n\n")
	} else {
		guidance = strings.Join([]string{
			"Agent get JSON is progressive: its default `conversation` view returns the latest three Turns newest-first, with chronological user/assistant body messages and an explicit `finalMessage`; `--view session` returns metadata only. Use `--turn-id <turn-id> --view trace` only when the current task needs that Turn's tool-call details, and page the trace with `--messages` or `--before-version` when necessary.",
			"When you need to wait for a launched or continued session to reach its next stop point, use `agent wait --session-id <session-id> --json`. `agent wait` blocks until the session's next stop point and does not fetch execution messages. Repeatedly calling `agent get` on a running session to check progress is an anti-pattern — it pulls message content an orchestrator should not be consuming between stop points. Use `agent get --session-id <session-id> --json` only when you need to consume or recover recent conversation context.",
			"Wait commands are single-call blocking operations. Invoke them once and let the CLI handle internal observation continuations; do not wrap them in a retry loop. Omit `--timeout-ms` to wait until a stop point. When an explicit total timeout expires, `timedOut: true` with `executionContinues: true` means only the local wait ended; the underlying session or run was not canceled.",
		}, "\n\n")
	}
	if commands := agentWorkflowCommandGuidance(input); commands != "" {
		guidance += "\n\n" + commands
	}
	return guidance
}

func agentWorkflowCommandGuidance(input PrepareInput) string {
	command := normalizeCLICommandName(input.CLICommand)
	profile := resolvedAgentWorkflow(input)
	if isDefaultAgentWorkflowProfile(profile) {
		return ""
	}
	lines := []string{"## Agent Host Command Contract", ""}
	switch profile.Cancellation {
	case AgentCancellationSession:
		lines = append(lines, "- Cancellation is session-scoped. Use `"+command+" agent cancel --session-id <session-id> --json`; this host does not expose `agent cancel-turn`.")
	default:
		lines = append(lines, "- Cancellation is Turn-scoped. Use `"+command+" agent cancel-turn --session-id <session-id> --turn-id <turn-id> --json`.")
	}
	switch profile.InteractionResponse {
	case AgentInteractionResponseUnavailable:
		lines = append(lines, "- This host does not expose `agent respond`. If `agent wait` stops for an approval, choice, or input, report the pending interaction instead of inventing a response command.")
	default:
		lines = append(lines, "- Pending approvals, choices, and input are answered with `"+command+" agent respond`; read current command help and use the identifiers returned by `agent wait`.")
	}
	switch profile.WorkspaceScope {
	case AgentWorkspaceScopeRoom:
		lines = append(lines, "- Agent sessions are room-scoped by the trusted runtime environment. Do not add `--room-id`; the managed host binds it outside the agent-facing command schema.")
	default:
		lines = append(lines, "- Agent sessions are scoped by the injected `TUTTI_WORKSPACE_ID`. Do not invent workspace ids or add host-specific room flags.")
	}
	if profile.TargetContinuation.Mode == AgentTargetContinuationExceptPrefixes {
		lines = append(lines, agentTargetContinuationGuidance(profile))
	}
	return strings.Join(lines, "\n")
}

func agentTargetContinuationGuidance(profile AgentWorkflowProfile) string {
	prefixes := make([]string, 0, len(profile.TargetContinuation.UnsupportedTargetIDPrefixes))
	for _, prefix := range profile.TargetContinuation.UnsupportedTargetIDPrefixes {
		prefixes = append(prefixes, "`"+prefix+"`")
	}
	return "- Targets selected from `agent list` whose ids start with " + strings.Join(prefixes, ", ") + " can be started, but their sessions do not support `agent send`, `agent get`, `agent wait`, cancellation, or `agent respond`. Do not promise a follow-up or result-fetch loop for those targets."
}

func agentImageHandoffGuidance(input PrepareInput) string {
	command := normalizeCLICommandName(input.CLICommand)
	profile := resolvedAgentWorkflow(input)
	switch profile.TurnResources {
	case AgentTurnResourcesReadPath:
		discovery := "`" + command + " agent get --session-id <caller-session-id> --view turns --json`"
		if profile.SessionContext == AgentSessionContextSummaryAndState {
			discovery = "`" + command + " agent session-summary --session-id <caller-session-id> --json`"
		}
		return strings.Join([]string{
			"## Forward Image Context",
			"",
			"When a handoff needs images from a caller turn, use " + discovery + " to identify candidate turn ids, then query a selected turn with `" + command + " agent turn-resources --session-id <caller-session-id> --turn-id <turnId> --json`.",
			"",
			"Returned `images[].readPath` values are host read endpoints, not local filesystem paths. Do not pass a `readPath` to `--image` or turn it into a guessed local path. Continue without forwarded images unless another supported command has materialized a readable local file.",
		}, "\n")
	case AgentTurnResourcesUnavailable:
		return strings.Join([]string{
			"## Forward Image Context",
			"",
			"This host does not expose readable turn resources. Do not scan attachment directories or construct paths from attachment ids. Ask the user to attach the needed image to the handoff when visual context is required.",
		}, "\n")
	default:
		return strings.Join([]string{
			"## Forward Image Context",
			"",
			"When a handoff needs images from a caller turn, use the metadata-only `" + command + " agent get --session-id <caller-session-id> --view turns --turns 20 --json` to discover candidate turn ids without loading conversation messages. If `hasMoreTurns` is true, continue with `--before-turn-id <oldest-returned-turn-id>`. Then query each selected turn with `" + command + " agent turn-resources --session-id <caller-session-id> --turn-id <turnId> --json`. Treat returned `images[].localPath` values as authoritative; do not scan attachment directories or construct paths from attachment ids.",
			"",
			"Add one `--image <localPath>` to `agent start` for each image chosen as structured visual input. If preserving prompt ordering is more useful, reference the image in the prompt as `[@filename](/absolute/path)` instead. Do not send the same image both ways unless the user explicitly asks, and continue without image arguments when no selected image has a usable local path.",
		}, "\n")
	}
}

func agentFetchGuidance(input PrepareInput) string {
	command := normalizeCLICommandName(input.CLICommand)
	restriction := ""
	if resolvedAgentWorkflow(input).TargetContinuation.Mode == AgentTargetContinuationExceptPrefixes {
		restriction = " This fetch path applies only to targets that support continuation; restricted target prefixes are start-only."
	}
	if resolvedAgentWorkflow(input).SessionContext == AgentSessionContextSummaryAndState {
		return "- Fetch (results must come back): read the peer conversation with `" + command + " agent session-summary --session-id <session-id> --json` instead of starting new work there. Use `" + command + " agent get --session-id <session-id> --json` only when session state is needed. When you delegate work whose output you must consume, request machine-consumable output, then apply the retrieved result." + restriction
	}
	return "- Fetch (results must come back): read the peer session with `" + command + " agent get --session-id <session-id> --json` instead of starting new work there. Its default conversation view exposes recent Turn results without tool-call noise. When you delegate work whose output you must consume, request machine-consumable output, then use the retrieved result to continue the current task — retrieval is not complete until the result is applied." + restriction
}

func agentWaitDisciplineGuidance(input PrepareInput) string {
	command := normalizeCLICommandName(input.CLICommand)
	contextCommand := "`agent get`"
	if resolvedAgentWorkflow(input).SessionContext == AgentSessionContextSummaryAndState {
		contextCommand = "`agent session-summary`"
	}
	return "Once work is delegated, trust the executor. Act only at stop points — where `" + command + " agent wait` returns with a non-timeout reason. Between stop points nothing is actionable: do not poll " + contextCommand + " for progress, do not read or relay partial outputs, and do not broadcast status updates — progress snapshots are context noise that crowds out what you will need at the real stop point, and the user can watch the session live in its own UI. Loop on bounded waits instead: `agent wait` with a timeout returns `timedOut` plus `latestVersion`, which increments with every message — if `latestVersion` is unchanged across several consecutive waits, the session may be stuck; surface that to the user rather than digging into its messages. " + contextCommand + " is a context-recovery tool for when you must consume or continue the work, not a progress poll."
}

func agentWaitDisciplineAndCommandGuidance(input PrepareInput) string {
	guidance := agentWaitDisciplineGuidance(input)
	if commands := agentWorkflowCommandGuidance(input); commands != "" {
		guidance += "\n\n" + commands
	}
	return guidance
}

func agentRuntimeGuidance(input PrepareInput) string {
	command := normalizeCLICommandName(input.CLICommand)
	profile := resolvedAgentWorkflow(input)
	lines := []string{
		"## Agent Launchers",
		"",
		"- Before starting an agent, run `" + command + " agent list --json` and choose an exact `agents[].id` from the current result. Do not infer an agent id from a provider name or assume a fixed provider set.",
		"- Start work with `" + command + " agent start --agent-id <agent-id> --prompt <task> --show --json`.",
		"- Before starting or messaging another agent, follow `$tutti-handoff`.",
	}
	if profile.TargetContinuation.Mode == AgentTargetContinuationExceptPrefixes {
		lines = append(lines,
			"- After `agent start` or `agent send`, use `"+command+" agent wait --session-id <session-id> --json` only when the selected target supports continuation. Restricted target prefixes are start-only.",
			"- For continuation-capable targets, call wait once and omit `--timeout-ms` to block to a stop point. A timeout ends only the local wait and never cancels execution.",
		)
	} else {
		lines = append(lines,
			"- After `agent start`, prefer `"+command+" agent wait --session-id <session-id> --json`.",
			"- After `agent send`, prefer `"+command+" agent wait --session-id <session-id> --json`.",
			"- Call wait once; omit `--timeout-ms` to block to a stop point. A timeout ends only the local wait and never cancels execution.",
		)
	}
	if profile.SessionContext == AgentSessionContextSummaryAndState {
		lines = append(lines, "- `agent wait` does not fetch execution messages; use `"+command+" agent session-summary --session-id <session-id> --json` only for conversation recovery and `"+command+" agent get --session-id <session-id> --json` only for state. Neither command is a progress poll. Ask for the task prompt, not a provider or model.")
	} else {
		lines = append(lines, "- `agent wait` does not fetch execution messages; use `"+command+" agent get --session-id <session-id> --json` only for recent conversation recovery — never as a progress poll on a running session. Use `--view turns` for metadata-only Turn discovery and `--turn-id <turn-id> --view trace` only when tool-call detail is needed. Ask for the task prompt, not a provider or model.")
	}
	lines = append(lines, "", agentRuntimeImageGuidance(input))
	if commands := agentWorkflowCommandGuidance(input); commands != "" {
		lines = append(lines, "", commands)
	}
	return strings.Join(lines, "\n")
}

func agentRuntimeImageGuidance(input PrepareInput) string {
	command := normalizeCLICommandName(input.CLICommand)
	switch resolvedAgentWorkflow(input).TurnResources {
	case AgentTurnResourcesReadPath:
		return "### Image Context\n\n- `" + command + " agent turn-resources` returns `images[].readPath` host endpoints, not local files. Do not pass them to `--image`; continue without image forwarding unless a supported command materializes a readable local file."
	case AgentTurnResourcesUnavailable:
		return "### Image Context\n\n- Turn image resources are unavailable in this host. Ask the user to attach required visual context; do not guess attachment paths."
	default:
		return "### Image Context\n\n- For image context, use `" + command + " agent get --session-id <caller-session-id> --view turns --turns 20 --json` to find turn ids without loading messages. Continue older pages with `--before-turn-id <oldest-returned-turn-id>` when `hasMoreTurns` is true, then use `" + command + " agent turn-resources --session-id <caller-session-id> --turn-id <turnId> --json`, and pass chosen images as `--image <localPath>`."
	}
}

func agentSkillBundleFallbackGuidance(input PrepareInput) string {
	command := normalizeCLICommandName(input.CLICommand)
	profile := resolvedAgentWorkflow(input)
	lines := make([]string, 0, 8)
	if profile.SessionContext == AgentSessionContextSummaryAndState {
		lines = append(lines, "- Agent-session mention: prefer `"+command+" agent wait --session-id <session-id> --json` for the next stop point; use `"+command+" agent session-summary --session-id <session-id> --json` for conversation recovery and `"+command+" agent get --session-id <session-id> --json` only for state. Do not use unsupported progressive `get --view ...` flags.")
	} else {
		lines = append(lines, "- Agent-session mention: prefer `"+command+" agent wait --session-id <session-id> --json` to block until the session's next stop point without fetching execution messages; use `"+command+" agent get --session-id <session-id> --json` only for recent conversation recovery, or add `--view turns` for metadata-only Turn discovery, never as a progress poll on a running session.")
	}
	if profile.TargetContinuation.Mode == AgentTargetContinuationExceptPrefixes {
		lines = append(lines,
			"- After `agent start` or `agent send`, use `"+command+" agent wait --session-id <session-id> --json` only for targets that support continuation. Restricted target prefixes are start-only.",
			"- For continuation-capable targets, call wait once and omit `--timeout-ms` to block to a stop point. A timeout ends only the local wait and never cancels execution.",
		)
	} else {
		lines = append(lines,
			"- After `agent start`, use `"+command+" agent wait --session-id <session-id> --json`.",
			"- After `agent send`, use `"+command+" agent wait --session-id <session-id> --json`; `agent wait` does not fetch execution messages.",
			"- Call wait once; omit `--timeout-ms` to block to a stop point. A timeout ends only the local wait and never cancels execution.",
		)
	}
	lines = append(lines, "- Agent-target mention: run `"+command+" agent list --agent-id <targetId> --json` to verify the current agent, then use `"+command+" agent start --agent-id <targetId> --prompt <task> --show --json` when a new session is required. Do not infer provider-specific commands or assume a fixed agent catalog. Active-peer inspection, historical session lookup, and other generic agent workflows are also valid. An instruction addressed to the mentioned agent must be handed off, not absorbed.")
	guidance := strings.Join(lines, "\n")
	if commands := agentWorkflowCommandGuidance(input); commands != "" {
		guidance += "\n\n" + commands
	}
	return guidance
}

func agentFallbackCommandGuideLines(input PrepareInput) []string {
	command := normalizeCLICommandName(input.CLICommand)
	profile := resolvedAgentWorkflow(input)
	lines := []string{
		fmt.Sprintf("- List available agents: `%s agent list --json` - Use this current catalog before starting an agent; do not assume a fixed provider set.", command),
		fmt.Sprintf("- Start an agent session: `%s agent start --agent-id <agent-id> --prompt <prompt> --json` - Add `--show` to request AgentGUI activation. Omit --model unless the user explicitly requested a model; the host uses the selected agent's configured/default model. Pass --image <path> multiple times only when this host exposes readable local image paths.", command),
		fmt.Sprintf("- List agent sessions: `%s agent sessions`", command),
	}
	if profile.SessionContext == AgentSessionContextSummaryAndState {
		lines = append(lines,
			fmt.Sprintf("- Wait for the next agent stop point without fetching execution messages: `%s agent wait --session-id <session-id> --json` - Use this after `agent start` or `agent send`; use `agent session-summary` when you need conversation messages.", command),
			fmt.Sprintf("- Get agent conversation summary: `%s agent session-summary --session-id <session-id> --json` - Use for conversation recovery.", command),
			fmt.Sprintf("- Get agent session state: `%s agent get --session-id <session-id> --json` - This host does not expose progressive conversation views on `agent get`.", command),
		)
	} else {
		lines = append(lines,
			fmt.Sprintf("- Wait for the next agent stop point without fetching execution messages: `%s agent wait --session-id <session-id> --json` - Use this after `agent start` or `agent send`; use `agent get` when you need recent conversation context.", command),
			fmt.Sprintf("- Get recent agent conversation: `%s agent get --session-id <session-id> --json` - Returns the latest three Turns newest-first, with chronological body messages and an explicit finalMessage for each Turn.", command),
			fmt.Sprintf("- Discover agent Turns without messages: `%s agent get --session-id <session-id> --view turns --json` - Page older Turns with --before-turn-id using the oldest returned turn id when hasMoreTurns is true.", command),
			fmt.Sprintf("- Inspect one agent Turn trace: `%s agent get --session-id <session-id> --turn-id <turn-id> --view trace --json` - Use only when tool-call detail is needed; add --messages or --before-version for bounded paging.", command),
		)
	}
	if profile.TurnResources != AgentTurnResourcesUnavailable {
		lines = append(lines, fmt.Sprintf("- Get resources from one agent turn: `%s agent turn-resources --session-id <session-id> --turn-id <turn-id> --json`", command))
	}
	if profile.Cancellation == AgentCancellationSession {
		lines = append(lines, fmt.Sprintf("- Cancel an agent session: `%s agent cancel --session-id <session-id> --json`", command))
	} else {
		lines = append(lines, fmt.Sprintf("- Cancel one agent Turn: `%s agent cancel-turn --session-id <session-id> --turn-id <turn-id> --json`", command))
	}
	if profile.InteractionResponse == AgentInteractionResponseCommand {
		lines = append(lines, fmt.Sprintf("- Respond to a pending agent interaction: `%s agent respond --help` - Use identifiers returned by `agent wait`.", command))
	}
	if profile.TargetContinuation.Mode == AgentTargetContinuationExceptPrefixes {
		lines = append(lines, agentTargetContinuationGuidance(profile))
	}
	lines = append(lines, fmt.Sprintf("- Show active peer agents: `%s agent active-peers --json`", command))
	return lines
}

func fallbackCommandGuideForWorkflow(input PrepareInput) string {
	defaultLines := strings.Split(fallbackCommandGuide(input.CLICommand), "\n")
	lines := make([]string, 0, len(defaultLines)+4)
	insertedAgentLines := false
	for _, line := range defaultLines {
		if strings.HasPrefix(line, "- List available agents:") {
			lines = append(lines, agentFallbackCommandGuideLines(input)...)
			insertedAgentLines = true
		}
		if isDefaultAgentFallbackGuideLine(line) {
			continue
		}
		lines = append(lines, line)
	}
	if !insertedAgentLines {
		lines = append(lines, agentFallbackCommandGuideLines(input)...)
	}
	return strings.Join(lines, "\n")
}

func isDefaultAgentFallbackGuideLine(line string) bool {
	for _, prefix := range []string{
		"- List available agents:",
		"- Start an agent session:",
		"- List agent sessions:",
		"- Wait for the next agent stop point",
		"- Get recent agent conversation:",
		"- Discover agent Turns without messages:",
		"- Inspect one agent Turn trace:",
		"- Get resources from one agent turn:",
		"- Show active peer agents:",
	} {
		if strings.HasPrefix(line, prefix) {
			return true
		}
	}
	return false
}

func commandGuideFromResolvedCapabilities(input PrepareInput) string {
	resolved := input.commandCapabilities
	if resolved == nil || !resolved.hostProvided {
		if isDefaultAgentWorkflowProfile(resolvedAgentWorkflow(input)) {
			return fallbackCommandGuide(input.CLICommand)
		}
		return fallbackCommandGuideForWorkflow(input)
	}
	if len(relevantRuntimeCommands(normalizeCLICommandName(input.CLICommand), resolved.commands)) == 0 {
		return "- No agent-facing runtime CLI commands were advertised by the current host."
	}
	return commandGuideFromCapabilities(input.CLICommand, resolved.commands)
}
