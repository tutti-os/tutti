package sessionreplay

import (
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"sort"
	"strings"

	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
)

var ErrTuttiReplayStateConflict = errors.New("tutti replay state conflict")

const SchemaVersion = 1
const StateFormat = "tutti.agent-session-replay-state.v1"

type TuttiReplayState struct {
	SchemaVersion int                   `json:"schemaVersion"`
	Agent         TuttiReplayAgent      `json:"agent"`
	TuttiMode     TuttiReplayTuttiMode  `json:"tuttiMode"`
	Workflows     []TuttiReplayWorkflow `json:"workflows"`
	Issues        []TuttiReplayIssue    `json:"issues"`
}

type TuttiReplayAgent = agenthost.HistoricalSessionGraph
type TuttiReplaySession = agenthost.HistoricalSession
type TuttiReplayTurn = agenthost.HistoricalTurn
type TuttiReplayMessage = agenthost.HistoricalMessage
type TuttiReplayInteraction = agenthost.HistoricalInteraction
type TuttiReplayGoal = agenthost.HistoricalGoal

type TuttiReplayTuttiMode struct {
	Activations   []TuttiReplayActivation   `json:"activations"`
	TurnSnapshots []TuttiReplayTurnSnapshot `json:"turnSnapshots"`
}

type TuttiReplayActivation struct {
	ID                string `json:"id"`
	SessionID         string `json:"sessionId"`
	CurrentRevisionID string `json:"currentRevisionId"`
	CurrentRevision   int64  `json:"currentRevision"`
	State             string `json:"state"`
	Source            string `json:"source"`
	Effect            int    `json:"effect"`
	Speed             int    `json:"speed"`
}

type TuttiReplayTurnSnapshot struct {
	SessionID         string `json:"sessionId"`
	TurnID            string `json:"turnId"`
	ActivationID      string `json:"activationId,omitempty"`
	RevisionID        string `json:"revisionId,omitempty"`
	Revision          int64  `json:"revision"`
	State             string `json:"state"`
	Source            string `json:"source,omitempty"`
	PreferenceVersion int    `json:"preferenceVersion"`
	Effect            int    `json:"effect"`
	Speed             int    `json:"speed"`
	DispatchState     string `json:"dispatchState"`
}

type TuttiReplayWorkflow struct {
	ID                string   `json:"id"`
	Type              string   `json:"type"`
	TriggerKind       string   `json:"triggerKind"`
	SourceSessionID   string   `json:"sourceSessionId"`
	SourceTurnID      string   `json:"sourceTurnId"`
	SourceToolCallID  string   `json:"sourceToolCallId"`
	Status            string   `json:"status"`
	CurrentRevisionID string   `json:"currentRevisionId"`
	IssueIDs          []string `json:"issueIds"`
}

type TuttiReplayIssue struct {
	ID      string                 `json:"id"`
	Title   string                 `json:"title"`
	Content string                 `json:"content,omitempty"`
	Status  string                 `json:"status"`
	Tasks   []TuttiReplayIssueTask `json:"tasks"`
}

type TuttiReplayIssueTask struct {
	ID       string `json:"id"`
	Title    string `json:"title"`
	Content  string `json:"content,omitempty"`
	Status   string `json:"status"`
	Priority string `json:"priority"`
	Position int    `json:"position"`
}

type TuttiReplayStateConflictError struct {
	Path string
}

func (e *TuttiReplayStateConflictError) Error() string {
	return fmt.Sprintf("%s at %s", ErrTuttiReplayStateConflict, e.Path)
}

func (*TuttiReplayStateConflictError) Unwrap() error {
	return ErrTuttiReplayStateConflict
}

type TuttiReplayMergedState struct {
	Agents    []agenthost.HistoricalSessionGraph
	TuttiMode TuttiReplayTuttiMode
	Workflows []TuttiReplayWorkflow
	Issues    []TuttiReplayIssue
}

// ProjectPortableAgentState removes provider runtime context that is not part
// of Tutti's semantic replay contract. Tool-owned nested arguments remain
// untouched; canceled-Turn completion watermarks, durable turn.fileChanges
// paths, materialized attachment paths, and runtime message envelopes are
// projected.
func ProjectPortableAgentState(
	agent TuttiReplayAgent,
	stateDirectory string,
) TuttiReplayAgent {
	projected := agent
	projected.Sessions = make([]TuttiReplaySession, len(agent.Sessions))
	copy(projected.Sessions, agent.Sessions)
	rootCWD := replayRootCWD(agent)
	for sessionIndex := range projected.Sessions {
		session := &projected.Sessions[sessionIndex]
		sourceSession := &agent.Sessions[sessionIndex]
		providerHome := replayProviderHome(
			*sourceSession,
			stateDirectory,
		)
		session.Cwd = portableAgentStatePath(session.Cwd, rootCWD)
		session.RailProjectPath = portableAgentStatePath(
			session.RailProjectPath,
			rootCWD,
		)
		if session.RailSectionKind == storesqlite.RailSectionKindProject &&
			storesqlite.NormalizeRailSectionKey(session.RailSectionKey) ==
				storesqlite.RailSectionKeyForProject(sourceSession.RailProjectPath) {
			session.RailSectionKey = "project:" + session.RailProjectPath
		}
		session.Turns = make([]TuttiReplayTurn, len(sourceSession.Turns))
		copy(session.Turns, sourceSession.Turns)
		for turnIndex := range session.Turns {
			projectPortableCanceledTurnCompletionWatermark(
				&session.Turns[turnIndex],
			)
			projectPortableTurnFileChanges(&session.Turns[turnIndex], rootCWD)
		}
		session.Messages = make([]TuttiReplayMessage, len(session.Messages))
		copy(session.Messages, sourceSession.Messages)
		for messageIndex := range session.Messages {
			message := &session.Messages[messageIndex]
			projectPortablePlanDecisionMessage(message)
			projectPortableGeneratedImageMessage(message, providerHome)
			projectPortableMessagePayload(message, rootCWD)
		}
		session.Interactions = make(
			[]TuttiReplayInteraction,
			len(sourceSession.Interactions),
		)
		copy(session.Interactions, sourceSession.Interactions)
		for interactionIndex := range session.Interactions {
			interaction := &session.Interactions[interactionIndex]
			interaction.Input = projectPortableToolCallInput(
				interaction.Input,
				rootCWD,
			)
		}
	}
	return projected
}

func replayProviderHome(
	session TuttiReplaySession,
	stateDirectory string,
) string {
	descriptor, ok := ResolveProviderReplay(
		session.AgentTargetID,
		session.Provider,
	)
	if !ok {
		// Shared Agent Sessions use a runtime-specific shared-agent:<id> target
		// while retaining the provider identity in the canonical Session. The
		// provider descriptor still owns portable runtime paths for that Session.
		descriptor, ok = FindProviderReplayByProvider(session.Provider)
	}
	directory := strings.TrimSpace(
		descriptor.PortableRuntime.SessionHomeDirectory,
	)
	if !ok || directory == "" {
		return ""
	}
	return filepath.Join(
		filepath.Clean(strings.TrimSpace(stateDirectory)),
		"agent",
		"runs",
		session.ID,
		directory,
	)
}

func projectPortableGeneratedImageMessage(
	message *TuttiReplayMessage,
	providerHome string,
) {
	if message.Kind != "tool_call" || !filepath.IsAbs(providerHome) {
		return
	}
	output, ok := message.Payload["output"].(map[string]any)
	if !ok {
		return
	}
	projectedOutput := cloneReplayMap(output)
	changed := false
	if savedPath, ok := output["savedPath"].(string); ok {
		if portable, ok := portableGeneratedImagePath(savedPath, providerHome); ok {
			projectedOutput["savedPath"] = portable
			changed = true
		}
	}
	if savedPaths, ok := output["savedPaths"].([]any); ok {
		projectedPaths := append([]any(nil), savedPaths...)
		for index, value := range projectedPaths {
			savedPath, ok := value.(string)
			if !ok {
				continue
			}
			if portable, ok := portableGeneratedImagePath(savedPath, providerHome); ok {
				projectedPaths[index] = portable
				changed = true
			}
		}
		projectedOutput["savedPaths"] = projectedPaths
	}
	if changed {
		payload := cloneReplayMap(message.Payload)
		payload["output"] = projectedOutput
		message.Payload = payload
	}
}

func projectPortableMessagePayload(
	message *TuttiReplayMessage,
	rootCWD string,
) {
	payload := cloneReplayMap(message.Payload)
	// clientSubmitId on assistant/tool messages is a live transport envelope.
	// User messages retain it because it identifies the submitted instruction.
	// Keep the empty-role case for older hand-authored cassettes whose fixture
	// schema predates the role field; real captured messages always set Role.
	if message.Role != "" && message.Role != "user" {
		delete(payload, "clientSubmitId")
	}
	if message.Kind == "tool_call" {
		if input, ok := payload["input"].(map[string]any); ok {
			payload["input"] = projectPortableToolCallInput(input, rootCWD)
		}
		projectedPayload, _ := projectPortablePathFields(payload, rootCWD).(map[string]any)
		payload = projectedPayload
	}
	projectPortableMaterializedContent(payload)
	message.Payload = payload
}

func projectPortableMaterializedContent(payload map[string]any) {
	var content []any
	switch value := payload["content"].(type) {
	case []any:
		content = value
	case []map[string]any:
		content = make([]any, len(value))
		for index, block := range value {
			content[index] = block
		}
	default:
		return
	}
	projectedContent := make([]any, len(content))
	for index, value := range content {
		block, ok := value.(map[string]any)
		if !ok {
			projectedContent[index] = value
			continue
		}
		projectedBlock := cloneReplayMap(block)
		blockType, _ := projectedBlock["type"].(string)
		if blockType == "text" || blockType == "image" {
			// Workspace-local / transport locators are not part of the portable
			// semantic contract. Final compare also strips attachmentId (see
			// stripVolatilePromptImageLocators) because shared object-upload
			// replay may omit it while recorded local cassettes still carry it.
			delete(projectedBlock, "path")
			delete(projectedBlock, "url")
			delete(projectedBlock, "uri")
			delete(projectedBlock, "assetId")
			delete(projectedBlock, "uploadStatus")
		}
		projectedContent[index] = projectedBlock
	}
	payload["content"] = projectedContent
}

func portableGeneratedImagePath(value, providerHome string) (string, bool) {
	value = filepath.Clean(strings.TrimSpace(value))
	relative, err := filepath.Rel(providerHome, value)
	if err != nil || filepath.IsAbs(relative) ||
		relative == ".." ||
		strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return "", false
	}
	portable := filepath.ToSlash(relative)
	if !strings.HasPrefix(portable, "generated_images/") {
		return "", false
	}
	return PortableReplayHomeToken + "/" + portable, true
}

func projectPortableCanceledTurnCompletionWatermark(turn *TuttiReplayTurn) {
	if strings.TrimSpace(turn.Outcome) != "canceled" ||
		turn.CompletedCommand == nil {
		return
	}
	completedCommand := cloneReplayMap(turn.CompletedCommand)
	delete(completedCommand, "finalAssistantMessageId")
	delete(completedCommand, "finalAssistantMessageResolved")
	if len(completedCommand) == 0 {
		completedCommand = nil
	}
	turn.CompletedCommand = completedCommand
}

func projectPortableTurnFileChanges(turn *TuttiReplayTurn, rootCWD string) {
	if len(turn.FileChanges) == 0 {
		return
	}
	projected, _ := projectPortablePathFields(turn.FileChanges, rootCWD).(map[string]any)
	turn.FileChanges = projected
}

func resolvePortableTurnFileChanges(
	turn *TuttiReplayTurn,
	replayCWD string,
) error {
	if len(turn.FileChanges) == 0 {
		return nil
	}
	resolved, err := resolvePortablePathFields(turn.FileChanges, replayCWD)
	if err != nil {
		return err
	}
	resolvedChanges, _ := resolved.(map[string]any)
	turn.FileChanges = resolvedChanges
	return nil
}

// ResolvePortableAgentState materializes Session binding fields and durable
// turn.fileChanges paths relative to the replay runtime root. User-authored
// payloads remain untouched.
func ResolvePortableAgentState(
	agent TuttiReplayAgent,
	replayCWD string,
) (TuttiReplayAgent, error) {
	replayCWD = filepath.Clean(strings.TrimSpace(replayCWD))
	if replayCWD == "." || !filepath.IsAbs(replayCWD) {
		return TuttiReplayAgent{}, errors.New("replay cwd must be absolute")
	}
	resolved := agent
	resolved.Sessions = make([]TuttiReplaySession, len(agent.Sessions))
	copy(resolved.Sessions, agent.Sessions)
	for index := range resolved.Sessions {
		session := &resolved.Sessions[index]
		var err error
		session.Cwd, err = resolvePortableReplayPath(session.Cwd, replayCWD)
		if err != nil {
			return TuttiReplayAgent{}, err
		}
		session.RailProjectPath, err = resolvePortableReplayPath(
			session.RailProjectPath,
			replayCWD,
		)
		if err != nil {
			return TuttiReplayAgent{}, err
		}
		if strings.HasPrefix(
			session.RailSectionKey,
			"project:"+PortableReplayCWDToken,
		) {
			portablePath := strings.TrimPrefix(session.RailSectionKey, "project:")
			projectPath, err := resolvePortableReplayPath(portablePath, replayCWD)
			if err != nil {
				return TuttiReplayAgent{}, err
			}
			session.RailSectionKey = storesqlite.RailSectionKeyForProject(projectPath)
		}
		sourceTurns := session.Turns
		session.Turns = make([]TuttiReplayTurn, len(sourceTurns))
		copy(session.Turns, sourceTurns)
		for turnIndex := range session.Turns {
			if err := resolvePortableTurnFileChanges(
				&session.Turns[turnIndex],
				replayCWD,
			); err != nil {
				return TuttiReplayAgent{}, err
			}
		}
		sourceMessages := session.Messages
		session.Messages = make([]TuttiReplayMessage, len(sourceMessages))
		copy(session.Messages, sourceMessages)
		for messageIndex := range session.Messages {
			message := &session.Messages[messageIndex]
			if message.Kind != "tool_call" {
				continue
			}
			payload := cloneReplayMap(message.Payload)
			if input, ok := payload["input"].(map[string]any); ok {
				resolvedInput, err := resolvePortableToolCallInput(
					input,
					replayCWD,
				)
				if err != nil {
					return TuttiReplayAgent{}, err
				}
				payload["input"] = resolvedInput
			}
			resolvedPayload, err := resolvePortablePathFields(payload, replayCWD)
			if err != nil {
				return TuttiReplayAgent{}, err
			}
			message.Payload, _ = resolvedPayload.(map[string]any)
		}
		sourceInteractions := session.Interactions
		session.Interactions = make(
			[]TuttiReplayInteraction,
			len(sourceInteractions),
		)
		copy(session.Interactions, sourceInteractions)
		for interactionIndex := range session.Interactions {
			interaction := &session.Interactions[interactionIndex]
			resolvedInput, err := resolvePortableToolCallInput(
				interaction.Input,
				replayCWD,
			)
			if err != nil {
				return TuttiReplayAgent{}, err
			}
			interaction.Input = resolvedInput
		}
	}
	return resolved, nil
}

func replayRootCWD(agent TuttiReplayAgent) string {
	for _, session := range agent.Sessions {
		if session.ID == agent.RootSessionID {
			return strings.TrimSpace(session.Cwd)
		}
	}
	return ""
}

func portableAgentStatePath(path, root string) string {
	path = strings.TrimSpace(path)
	root = strings.TrimSpace(root)
	if path == "" || root == "" {
		return path
	}
	// Normalize before Rel so macOS /var vs /private/var forms of the same
	// directory project to ${REPLAY_CWD} instead of leaking absolute paths.
	normalizedPath := storesqlite.NormalizeProjectPath(path)
	normalizedRoot := storesqlite.NormalizeProjectPath(root)
	if normalizedPath == "" || normalizedRoot == "" {
		return path
	}
	relative, err := filepath.Rel(normalizedRoot, normalizedPath)
	if err != nil || relative == ".." ||
		strings.HasPrefix(relative, ".."+string(filepath.Separator)) ||
		filepath.IsAbs(relative) {
		// Shared-agent owner remaps session.Cwd under /workspace/<roomId>/...
		// while rail project metadata stays on the logical /workspace/... path.
		// Treat either direction as the portable replay root.
		if sharedWorkspaceRemappedCWDEqual(normalizedPath, normalizedRoot) ||
			sharedWorkspaceRemappedCWDEqual(normalizedRoot, normalizedPath) {
			return PortableReplayCWDToken
		}
		return path
	}
	if relative == "." {
		return PortableReplayCWDToken
	}
	return PortableReplayCWDToken + "/" + filepath.ToSlash(relative)
}

func resolvePortableReplayPath(path, replayCWD string) (string, error) {
	path = strings.TrimSpace(path)
	if path == "" {
		return "", nil
	}
	if path == PortableReplayCWDToken {
		return replayCWD, nil
	}
	prefix := PortableReplayCWDToken + "/"
	if !strings.HasPrefix(path, prefix) {
		return path, nil
	}
	relative := filepath.FromSlash(strings.TrimPrefix(path, prefix))
	resolved := filepath.Clean(filepath.Join(replayCWD, relative))
	within, err := filepath.Rel(replayCWD, resolved)
	if err != nil || within == ".." ||
		strings.HasPrefix(within, ".."+string(filepath.Separator)) ||
		filepath.IsAbs(within) {
		return "", errors.New("portable replay path escapes replay cwd")
	}
	return resolved, nil
}

func projectPortablePlanDecisionMessage(message *TuttiReplayMessage) {
	clientSubmitID, _ := message.Payload["clientSubmitId"].(string)
	if strings.HasPrefix(
		strings.TrimSpace(clientSubmitID),
		"plan-decision:",
	) {
		const portableClientSubmitID = "plan-decision:<runtime-operation>"
		payload := cloneReplayMap(message.Payload)
		payload["clientSubmitId"] = portableClientSubmitID
		message.Payload = payload
		if message.ID == "client-submit:user:"+clientSubmitID {
			message.ID = "client-submit:user:" + portableClientSubmitID
		}
		return
	}
	noticeKind, _ := message.Payload["noticeKind"].(string)
	operationID, _ := message.Payload["operationId"].(string)
	if !strings.HasPrefix(noticeKind, "plan_implementation_") ||
		strings.TrimSpace(operationID) == "" {
		return
	}
	const portableOperationID = "<runtime-operation>"
	payload := cloneReplayMap(message.Payload)
	payload["operationId"] = portableOperationID
	message.Payload = payload
	if message.ID == "plan-decision:"+operationID+":status" {
		message.ID = "plan-decision:" + portableOperationID + ":status"
	}
}

func projectPortableApprovalInput(input map[string]any) map[string]any {
	projectedInput := cloneReplayMap(input)
	delete(projectedInput, "cwd")
	projectPortableCommandField(projectedInput, "command")
	if toolCall, ok := projectedInput["toolCall"].(map[string]any); ok {
		projectedToolCall := cloneReplayMap(toolCall)
		projectPortableCommandField(projectedToolCall, "title")
		if toolCallInput, ok := projectedToolCall["input"].(map[string]any); ok {
			projectedToolCallInput := cloneReplayMap(toolCallInput)
			delete(projectedToolCallInput, "cwd")
			projectPortableCommandField(projectedToolCallInput, "command")
			projectedToolCall["input"] = projectedToolCallInput
		}
		projectedInput["toolCall"] = projectedToolCall
	}
	return projectedInput
}

func projectPortableToolCallInput(
	input map[string]any,
	rootCWD string,
) map[string]any {
	projectedInput := projectPortableApprovalInput(input)
	projected, _ := projectPortablePathFields(projectedInput, rootCWD).(map[string]any)
	return projected
}

func resolvePortableToolCallInput(
	input map[string]any,
	replayCWD string,
) (map[string]any, error) {
	if input == nil {
		return nil, nil
	}
	resolved, err := resolvePortablePathFields(input, replayCWD)
	if err != nil {
		return nil, err
	}
	resolvedInput, _ := resolved.(map[string]any)
	return resolvedInput, nil
}

func projectPortablePathFields(value any, rootCWD string) any {
	switch value := value.(type) {
	case map[string]any:
		projected := make(map[string]any, len(value))
		for key, child := range value {
			lowerKey := strings.ToLower(key)
			// cwd stripping stays in projectPortableApprovalInput; here we only
			// rewrite path-bearing strings so tool-owned nested cwd can remain.
			if childPath, ok := child.(string); ok &&
				strings.Contains(lowerKey, "path") {
				projected[key] = portableAgentStatePath(childPath, rootCWD)
				continue
			}
			projected[key] = projectPortablePathFields(child, rootCWD)
		}
		return projected
	case []any:
		projected := make([]any, len(value))
		for index, child := range value {
			projected[index] = projectPortablePathFields(child, rootCWD)
		}
		return projected
	default:
		return value
	}
}

func resolvePortablePathFields(value any, replayCWD string) (any, error) {
	switch value := value.(type) {
	case map[string]any:
		resolved := make(map[string]any, len(value))
		for key, child := range value {
			lowerKey := strings.ToLower(key)
			if childPath, ok := child.(string); ok &&
				strings.Contains(lowerKey, "path") {
				resolvedPath, err := resolvePortableReplayPath(
					childPath,
					replayCWD,
				)
				if err != nil {
					return nil, err
				}
				resolved[key] = resolvedPath
				continue
			}
			resolvedChild, err := resolvePortablePathFields(child, replayCWD)
			if err != nil {
				return nil, err
			}
			resolved[key] = resolvedChild
		}
		return resolved, nil
	case []any:
		resolved := make([]any, len(value))
		for index, child := range value {
			resolvedChild, err := resolvePortablePathFields(child, replayCWD)
			if err != nil {
				return nil, err
			}
			resolved[index] = resolvedChild
		}
		return resolved, nil
	default:
		return value, nil
	}
}

func projectPortableCommandField(input map[string]any, key string) {
	command, ok := input[key].(string)
	if !ok {
		return
	}
	command = strings.TrimSpace(command)
	executable, arguments, hasArguments := strings.Cut(command, " ")
	if !filepath.IsAbs(executable) {
		return
	}
	projected := filepath.Base(executable)
	if hasArguments {
		projected += " " + arguments
	}
	input[key] = projected
}

func cloneReplayMap(source map[string]any) map[string]any {
	if source == nil {
		return nil
	}
	cloned := make(map[string]any, len(source))
	for key, value := range source {
		cloned[key] = value
	}
	return cloned
}

func ValidateTuttiReplayState(state TuttiReplayState) error {
	if state.SchemaVersion != SchemaVersion {
		return fmt.Errorf("unsupported tutti replay state schema %d", state.SchemaVersion)
	}
	if err := agenthost.ValidateHistoricalSessionGraph(state.Agent); err != nil {
		return err
	}
	if state.TuttiMode.Activations == nil ||
		state.TuttiMode.TurnSnapshots == nil ||
		state.Workflows == nil ||
		state.Issues == nil {
		return errors.New("tutti replay state sections must be explicit arrays")
	}
	for _, workflow := range state.Workflows {
		if workflow.IssueIDs == nil {
			return fmt.Errorf(
				"tutti replay state workflow %q must have explicit issueIds",
				workflow.ID,
			)
		}
	}
	raw, err := json.Marshal(state)
	if err != nil {
		return err
	}
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		return err
	}
	return validateReplayPortableValue("$", "", value)
}

func validateReplayPortableValue(path, key string, value any) error {
	switch value := value.(type) {
	case map[string]any:
		for childKey, child := range value {
			if childKey == "workspaceId" {
				return fmt.Errorf("tutti replay state contains non-portable %s.%s", path, childKey)
			}
			if err := validateReplayPortableValue(
				path+"."+childKey,
				childKey,
				child,
			); err != nil {
				return err
			}
		}
	case []any:
		for index, child := range value {
			if err := validateReplayPortableValue(
				fmt.Sprintf("%s[%d]", path, index),
				key,
				child,
			); err != nil {
				return err
			}
		}
	case string:
		lowerKey := strings.ToLower(key)
		if (strings.Contains(lowerKey, "path") || lowerKey == "cwd") &&
			(filepath.IsAbs(value) || strings.HasPrefix(value, "file://")) {
			return fmt.Errorf("tutti replay state contains absolute path at %s", path)
		}
	}
	return nil
}

func MergeTuttiReplayStates(
	states []TuttiReplayState,
) (TuttiReplayMergedState, error) {
	for _, state := range states {
		if err := ValidateTuttiReplayState(state); err != nil {
			return TuttiReplayMergedState{}, err
		}
	}
	return mergeTuttiReplayStatesValidated(states)
}

func mergeTuttiReplayStatesValidated(
	states []TuttiReplayState,
) (TuttiReplayMergedState, error) {
	merged := TuttiReplayMergedState{
		Agents: []agenthost.HistoricalSessionGraph{},
		TuttiMode: TuttiReplayTuttiMode{
			Activations:   []TuttiReplayActivation{},
			TurnSnapshots: []TuttiReplayTurnSnapshot{},
		},
		Workflows: []TuttiReplayWorkflow{},
		Issues:    []TuttiReplayIssue{},
	}
	sessionObjects := map[string]any{}
	activationObjects := map[string]any{}
	snapshotObjects := map[string]any{}
	workflowObjects := map[string]any{}
	issueObjects := map[string]any{}
	for _, state := range states {
		for _, session := range state.Agent.Sessions {
			if err := mergeReplayObject(
				"$.agent.sessions["+session.ID+"]",
				session.ID,
				session,
				sessionObjects,
			); err != nil {
				return TuttiReplayMergedState{}, err
			}
		}
		merged.Agents = append(merged.Agents, state.Agent)
		for _, activation := range state.TuttiMode.Activations {
			if err := mergeReplayObject(
				"$.tuttiMode.activations["+activation.ID+"]",
				activation.ID,
				activation,
				activationObjects,
			); err != nil {
				return TuttiReplayMergedState{}, err
			}
		}
		for _, snapshot := range state.TuttiMode.TurnSnapshots {
			key := snapshot.SessionID + "\x00" + snapshot.TurnID
			if err := mergeReplayObject(
				"$.tuttiMode.turnSnapshots["+snapshot.SessionID+"/"+snapshot.TurnID+"]",
				key,
				snapshot,
				snapshotObjects,
			); err != nil {
				return TuttiReplayMergedState{}, err
			}
		}
		for _, workflow := range state.Workflows {
			if err := mergeReplayObject(
				"$.workflows["+workflow.ID+"]",
				workflow.ID,
				workflow,
				workflowObjects,
			); err != nil {
				return TuttiReplayMergedState{}, err
			}
		}
		for _, issue := range state.Issues {
			if err := mergeReplayObject(
				"$.issues["+issue.ID+"]",
				issue.ID,
				issue,
				issueObjects,
			); err != nil {
				return TuttiReplayMergedState{}, err
			}
		}
	}
	merged.TuttiMode.Activations = replayObjectValues[TuttiReplayActivation](activationObjects)
	merged.TuttiMode.TurnSnapshots = replayObjectValues[TuttiReplayTurnSnapshot](snapshotObjects)
	merged.Workflows = replayObjectValues[TuttiReplayWorkflow](workflowObjects)
	merged.Issues = replayObjectValues[TuttiReplayIssue](issueObjects)
	sort.Slice(merged.Agents, func(i, j int) bool {
		return merged.Agents[i].RootSessionID < merged.Agents[j].RootSessionID
	})
	return merged, nil
}

func mergeReplayObject(
	path, key string,
	value any,
	objects map[string]any,
) error {
	if existing, ok := objects[key]; ok {
		mismatch := firstReplayStateMismatch(path, existing, value)
		if mismatch != "" {
			return &TuttiReplayStateConflictError{Path: mismatch}
		}
		return nil
	}
	objects[key] = value
	return nil
}

func replayObjectValues[T any](objects map[string]any) []T {
	keys := make([]string, 0, len(objects))
	for key := range objects {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	result := make([]T, 0, len(keys))
	for _, key := range keys {
		result = append(result, objects[key].(T))
	}
	return result
}

func CompareTuttiReplayState(expected, actual TuttiReplayState) error {
	if err := ValidateTuttiReplayState(expected); err != nil {
		return fmt.Errorf("invalid expected Tutti Replay State: %w", err)
	}
	if err := ValidateTuttiReplayState(actual); err != nil {
		return fmt.Errorf("invalid actual Tutti Replay State: %w", err)
	}
	return compareTuttiReplayStateValidated(expected, actual)
}

func compareTuttiReplayStateValidated(
	expected, actual TuttiReplayState,
) error {
	expected = normalizeReplayStateForComparison(expected)
	actual = normalizeReplayStateForComparison(actual)
	if mismatch := firstReplayStateMismatch("$", expected, actual); mismatch != "" {
		return &TuttiReplayStateConflictError{Path: mismatch}
	}
	return nil
}
