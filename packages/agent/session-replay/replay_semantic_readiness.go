package sessionreplay

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"strings"

	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
)

func (r *SemanticRuntime) checkpointReadinessSatisfied(
	ctx context.Context,
	cassetteID string,
	checkpoint ReplayCheckpoint,
) (bool, error) {
	reader := semanticCanonicalReader{
		ctx:         ctx,
		host:        r.host,
		workspaceID: r.workspaceID,
		rootID:      r.registrations[cassetteID].RootSessionID,
		subjects:    checkpoint.Subjects,
		expected:    r.expectedBindings[cassetteID],
	}
	r.mu.Lock()
	if observation := r.observations[cassetteID]; observation != nil {
		reader.entities = observation.projector.entities.clone()
	}
	r.mu.Unlock()
	for _, address := range checkpoint.Subjects {
		if address.Origin.Source ==
			EntityOriginActivityEvent &&
			!reader.entities.bindActivityAddress(address) {
			return false, fmt.Errorf(
				"checkpoint_identity_unresolved: activity entity",
			)
		}
	}
	for _, predicate := range checkpoint.Readiness.All {
		if predicate.Subject < 0 ||
			predicate.Subject >= len(checkpoint.Subjects) {
			return false, fmt.Errorf(
				"checkpoint_identity_unresolved: checkpoint %q subject %d",
				checkpoint.ID,
				predicate.Subject,
			)
		}
		ready, err := reader.predicateSatisfied(predicate)
		if err != nil || !ready {
			return ready, err
		}
	}
	return true, nil
}

type semanticCanonicalReader struct {
	ctx         context.Context
	host        *agenthost.Host
	workspaceID string
	rootID      string
	subjects    []EntityAddress
	entities    replayEntityRegistry
	expected    agenthost.HistoricalSessionGraph
}

func (r semanticCanonicalReader) predicateSatisfied(
	predicate ReadinessPredicate,
) (bool, error) {
	subject := r.subjects[predicate.Subject]
	session, found, err := r.session(subject)
	if err != nil || !found {
		return false, err
	}
	switch predicate.Type {
	case "session.exists":
		if predicate.Equals != "true" {
			return false, fmt.Errorf(
				"checkpoint_plan_invalid: session.exists requires true",
			)
		}
		return true, nil
	case "session.status":
		actual := "ready"
		if session.ActiveTurnID != "" {
			actual = "working"
		}
		return actual == predicate.Equals, nil
	case "session.queue-empty":
		return session.ActiveTurnID == "", nil
	case "turn.phase", "turn.status":
		turn, found, err := r.turn(subject, session)
		if err != nil || !found {
			return false, err
		}
		if predicate.Type == "turn.phase" {
			// Recorded plans may carry the activity-layer phase vocabulary
			// (for example waiting_approval from a provider observation);
			// canonical turns persist the closed store vocabulary.
			return turn.Phase == canonicalTurnPhase(predicate.Equals), nil
		}
		actual := turn.Phase
		if turn.Outcome != "" {
			actual = turn.Outcome
		}
		return actual == predicate.Equals, nil
	case "interaction.status":
		interaction, found, err := r.interaction(subject, session)
		return found && interaction.Status == predicate.Equals, err
	case "call.status":
		message, found, err := r.call(subject, session)
		if err != nil || !found {
			return false, err
		}
		status, _ := message.Payload["status"].(string)
		// Prefer payload status then message.Status. Fold stream/activity
		// vocabularies (streaming/working) and interactive-wait sub-states
		// into running so recorded call.status=running stays satisfied.
		return canonicalCallStatus(firstNonEmpty(status, message.Status)) ==
			canonicalCallStatus(predicate.Equals), nil
	case "plan.status":
		turn, found, err := r.turn(subject, session)
		if err != nil || !found {
			return false, err
		}
		messages, err := r.messages(session.ID, turn.TurnID)
		if err != nil {
			return false, err
		}
		for _, message := range messages {
			messageKind, _ := message.Payload["messageKind"].(string)
			if message.TurnID == turn.TurnID &&
				messageKind == "plan" &&
				firstNonEmpty(message.Status, "completed") == predicate.Equals {
				return true, nil
			}
		}
		return false, nil
	case "compaction.status":
		turn, found, err := r.turn(subject, session)
		if err != nil || !found {
			return false, err
		}
		messages, err := r.messages(session.ID, turn.TurnID)
		if err != nil {
			return false, err
		}
		for _, message := range messages {
			command, _ := message.Payload["noticeCommand"].(string)
			status, _ := message.Payload["noticeCommandStatus"].(string)
			if command == "compact" && status == predicate.Equals {
				return true, nil
			}
		}
		return false, nil
	case "child-session.status":
		if subject.Kind != EntityKindSession ||
			subject.Origin.Source ==
				EntityOriginRecordingRoot {
			return false, nil
		}
		actual := "running"
		if session.EndedAtUnixMS > 0 {
			actual = "completed"
		}
		return actual == predicate.Equals, nil
	case "goal.status":
		if subject.Kind != EntityKindGoal {
			return false, nil
		}
		result, err := r.host.GetGoalState(r.ctx, agenthost.SessionRef{
			WorkspaceID:    r.workspaceID,
			AgentSessionID: session.ID,
		})
		if err != nil {
			return false, err
		}
		return semanticGoalStatus(result.State) == predicate.Equals, nil
	case "settings.equal":
		if predicate.Equals != "recorded" {
			return false, fmt.Errorf(
				"checkpoint_plan_invalid: settings.equal requires recorded",
			)
		}
		expected, found := resolveLogicalSession(
			subject,
			r.expected,
			r.entities,
		)
		// Expected-state capture can omit default-only composer keys (for
		// example speed:"standard") that live GetSession still materializes.
		// Require every recorded key to match; ignore live-only extras.
		return found && composerSettingsEqual(
			session.Settings,
			expected.Settings,
		), nil
	case "attachment.materialized":
		message, found, err := r.message(subject, session)
		if err != nil || !found {
			return false, err
		}
		content, ok := message.Payload["content"].([]any)
		if !ok {
			if typed, typedOK := message.Payload["content"].([]map[string]any); typedOK {
				content = make([]any, len(typed))
				for index := range typed {
					content[index] = typed[index]
				}
				ok = true
			}
		}
		binding, bound := r.entities.binding(subject)
		if !ok || !bound || binding.AttachmentIndex == 0 {
			return false, nil
		}
		var attachmentIndex uint64
		for _, item := range content {
			block, blockOK := item.(map[string]any)
			if !blockOK {
				continue
			}
			attachmentID, _ := block["attachmentId"].(string)
			if strings.TrimSpace(attachmentID) == "" {
				continue
			}
			attachmentIndex++
			if attachmentIndex == binding.AttachmentIndex {
				return true, nil
			}
		}
		return false, nil
	case "project.binding":
		if predicate.Equals != "recorded" {
			return false, fmt.Errorf(
				"checkpoint_plan_invalid: project.binding requires recorded",
			)
		}
		expected, found := resolveLogicalSession(
			subject,
			r.expected,
			r.entities,
		)
		return found && projectBindingMatches(session, expected), nil
	default:
		return false, fmt.Errorf(
			"checkpoint_plan_invalid: unsupported runtime readiness %q",
			predicate.Type,
		)
	}
}

// canonicalTurnPhase folds the activity-layer TurnPhase vocabulary that
// checkpoint recording captures from provider observations (working,
// waiting_approval, waiting_input, ...) into the closed canonical turn phase
// vocabulary persisted by the store, so readiness compares like with like.
func canonicalTurnPhase(phase string) string {
	switch strings.TrimSpace(phase) {
	case "working", "streaming":
		return storesqlite.TurnPhaseRunning
	case "waiting_approval", "awaiting_approval", "waiting_input":
		return storesqlite.TurnPhaseWaiting
	case "idle":
		return storesqlite.TurnPhaseSettled
	default:
		return strings.TrimSpace(phase)
	}
}

// canonicalCallStatus folds activity/stream-layer call vocabularies into the
// closed checkpoint readiness tokens (running/completed/failed). Recorded
// call.status=running must stay satisfied while the canonical message still
// carries payload.status "streaming"/"working" (ACP live tool frames) or an
// interactive-wait sub-state — same family as canonicalTurnPhase.
func canonicalCallStatus(status string) string {
	switch strings.TrimSpace(status) {
	case "working", "streaming", "in_progress", "pending",
		"waiting_approval", "awaiting_approval", "waiting_input":
		return "running"
	default:
		return strings.TrimSpace(status)
	}
}

func projectBindingMatches(
	actual storesqlite.Session,
	expected agenthost.HistoricalSession,
) bool {
	if strings.TrimSpace(actual.AgentTargetID) !=
		strings.TrimSpace(expected.AgentTargetID) ||
		strings.TrimSpace(actual.Provider) !=
			strings.TrimSpace(expected.Provider) ||
		strings.TrimSpace(actual.RailSectionKind) !=
			strings.TrimSpace(expected.RailSectionKind) ||
		storesqlite.NormalizeProjectPath(actual.RailProjectPath) !=
			storesqlite.NormalizeProjectPath(expected.RailProjectPath) ||
		storesqlite.NormalizeRailSectionKey(actual.RailSectionKey) !=
			storesqlite.NormalizeRailSectionKey(expected.RailSectionKey) {
		return false
	}
	actualCWD := storesqlite.NormalizeProjectPath(actual.Cwd)
	expectedCWD := storesqlite.NormalizeProjectPath(expected.Cwd)
	if actualCWD == expectedCWD {
		return true
	}
	// Shared-agent owner Host admission remaps logical /workspace/... cwd into
	// /workspace/<roomId>/... while rail project metadata stays on the recorded
	// logical path. Accept that confined remapping once rail fields already
	// matched.
	return sharedWorkspaceRemappedCWDEqual(actualCWD, expectedCWD)
}

// sharedWorkspaceRemappedCWDEqual reports whether actual is the TSH shared-agent
// confined form of expected: /workspace/<roomId>/<tail> for expected
// /workspace/<tail>.
func sharedWorkspaceRemappedCWDEqual(actual, expected string) bool {
	const workspacePrefix = "/workspace/"
	if actual == "" || expected == "" {
		return false
	}
	if !strings.HasPrefix(actual, workspacePrefix) ||
		!strings.HasPrefix(expected, workspacePrefix) {
		return false
	}
	expectedTail := strings.TrimPrefix(expected, workspacePrefix)
	if expectedTail == "" || expectedTail == "." {
		return false
	}
	rest := strings.TrimPrefix(actual, workspacePrefix)
	slash := strings.IndexByte(rest, '/')
	if slash <= 0 {
		return false
	}
	roomID := rest[:slash]
	if roomID == "" || strings.Contains(roomID, "/") {
		return false
	}
	return rest[slash+1:] == expectedTail
}

func composerSettingsEqual(actual, expected map[string]any) bool {
	// Shared by settings.equal readiness and final-state transport compare:
	// require every recorded key, treat empty defaults as absent, and ignore
	// live-only extras so older cassettes survive new default composer fields.
	if len(expected) == 0 {
		return true
	}
	for key, expectedValue := range expected {
		actualValue, ok := actual[key]
		if !ok {
			if composerSettingsValueEmpty(expectedValue) {
				continue
			}
			return false
		}
		if !composerSettingsValueEqual(actualValue, expectedValue) {
			return false
		}
	}
	return true
}

func composerSettingsValueEmpty(value any) bool {
	if value == nil {
		return true
	}
	switch typed := value.(type) {
	case string:
		return strings.TrimSpace(typed) == ""
	case bool:
		return !typed
	case *bool:
		return typed == nil
	default:
		return false
	}
}

func composerSettingsValueEqual(actual, expected any) bool {
	if composerSettingsValueEmpty(actual) &&
		composerSettingsValueEmpty(expected) {
		return true
	}
	actualBool, actualIsBool := composerSettingsBool(actual)
	expectedBool, expectedIsBool := composerSettingsBool(expected)
	if actualIsBool && expectedIsBool {
		return actualBool == expectedBool
	}
	actualText, actualIsText := actual.(string)
	expectedText, expectedIsText := expected.(string)
	if actualIsText && expectedIsText {
		return strings.TrimSpace(actualText) ==
			strings.TrimSpace(expectedText)
	}
	return reflect.DeepEqual(actual, expected)
}

func composerSettingsBool(value any) (bool, bool) {
	switch typed := value.(type) {
	case bool:
		return typed, true
	case *bool:
		if typed == nil {
			return false, true
		}
		return *typed, true
	default:
		return false, false
	}
}

func semanticGoalStatus(state storesqlite.SessionGoalState) string {
	if state.Tombstoned {
		return "cleared"
	}
	status, _ := state.Observed["status"].(string)
	switch strings.TrimSpace(status) {
	case "active", "running":
		return "running"
	case "paused":
		return "paused"
	case "complete", "completed":
		return "completed"
	}
	return firstNonEmpty(strings.TrimSpace(status), state.SyncStatus)
}

func (r semanticCanonicalReader) session(
	address EntityAddress,
) (storesqlite.Session, bool, error) {
	sessionID := ""
	if binding, ok := r.entities.binding(address); ok {
		sessionID = strings.TrimSpace(binding.SessionID)
	}
	// Unbound provider-observation turn subjects still need the root Session
	// so turn.phase readiness can fall back to ActiveTurnID after a lost
	// observation stamp (see turn()).
	if sessionID == "" &&
		address.Kind == EntityKindTurn &&
		address.Origin.Source ==
			EntityOriginProviderObservation {
		sessionID = strings.TrimSpace(r.rootID)
	}
	if sessionID == "" {
		return storesqlite.Session{}, false, nil
	}
	result, err := r.host.GetSession(r.ctx, agenthost.SessionRef{
		WorkspaceID:    r.workspaceID,
		AgentSessionID: sessionID,
	})
	if errors.Is(err, agenthost.ErrSessionNotFound) {
		return storesqlite.Session{}, false, nil
	}
	return result.Canonical, err == nil, err
}

func (r semanticCanonicalReader) turn(
	address EntityAddress,
	session storesqlite.Session,
) (storesqlite.Turn, bool, error) {
	binding, ok := r.entities.binding(address)
	if ok && binding.SessionID != "" && binding.TurnID != "" {
		return r.host.GetTurn(
			r.ctx,
			agenthost.SessionRef{
				WorkspaceID:    r.workspaceID,
				AgentSessionID: binding.SessionID,
			},
			binding.TurnID,
		)
	}
	// When a provider-observation trigger unit completed but its observation
	// stamp never bound the subject (compact turn/started is the known case),
	// the session's active Turn is the entity that observation would have
	// introduced at the barrier park point.
	if address.Kind == EntityKindTurn &&
		address.Origin.Source ==
			EntityOriginProviderObservation &&
		strings.TrimSpace(session.ActiveTurnID) != "" &&
		strings.TrimSpace(session.ID) != "" {
		return r.host.GetTurn(
			r.ctx,
			agenthost.SessionRef{
				WorkspaceID:    r.workspaceID,
				AgentSessionID: session.ID,
			},
			session.ActiveTurnID,
		)
	}
	return storesqlite.Turn{}, false, nil
}

func (r semanticCanonicalReader) interaction(
	address EntityAddress,
	_ storesqlite.Session,
) (storesqlite.Interaction, bool, error) {
	binding, ok := r.entities.binding(address)
	if !ok {
		return storesqlite.Interaction{}, false, nil
	}
	return r.host.GetInteraction(
		r.ctx,
		agenthost.SessionRef{
			WorkspaceID:    r.workspaceID,
			AgentSessionID: binding.SessionID,
		},
		binding.TurnID,
		binding.EntityID,
	)
}

func (r semanticCanonicalReader) call(
	address EntityAddress,
	_ storesqlite.Session,
) (storesqlite.Message, bool, error) {
	binding, ok := r.entities.binding(address)
	if !ok {
		return storesqlite.Message{}, false, nil
	}
	messages, err := r.messages(binding.SessionID, binding.TurnID)
	if err != nil {
		return storesqlite.Message{}, false, err
	}
	for _, message := range messages {
		callID, _ := message.Payload["callId"].(string)
		if strings.TrimSpace(callID) == binding.EntityID {
			return message, true, nil
		}
	}
	return storesqlite.Message{}, false, nil
}

func (r semanticCanonicalReader) message(
	address EntityAddress,
	_ storesqlite.Session,
) (storesqlite.Message, bool, error) {
	binding, ok := r.entities.binding(address)
	if !ok || binding.MessageID == "" {
		return storesqlite.Message{}, false, nil
	}
	messages, err := r.messages(binding.SessionID, "")
	if err != nil {
		return storesqlite.Message{}, false, err
	}
	for _, message := range messages {
		if message.MessageID == binding.MessageID {
			return message, true, nil
		}
	}
	return storesqlite.Message{}, false, nil
}

func (r semanticCanonicalReader) messages(
	sessionID, turnID string,
) ([]storesqlite.Message, error) {
	result := []storesqlite.Message{}
	var after uint64
	for {
		page, found, err := r.host.ListSessionMessages(
			r.ctx,
			agenthost.SessionRef{
				WorkspaceID:    r.workspaceID,
				AgentSessionID: sessionID,
			},
			agenthost.SessionMessageQuery{
				TurnID:       turnID,
				AfterVersion: after,
				Limit:        100,
				Order:        storesqlite.MessageOrderAsc,
			},
		)
		if err != nil || !found {
			return nil, err
		}
		result = append(result, page.Messages...)
		if !page.HasMore {
			return result, nil
		}
		if page.LatestVersion <= after {
			return nil, errors.New(
				"checkpoint_identity_unresolved: message cursor did not advance",
			)
		}
		after = page.LatestVersion
	}
}

func resolveLogicalSession(
	address EntityAddress,
	graph agenthost.HistoricalSessionGraph,
	entities replayEntityRegistry,
) (agenthost.HistoricalSession, bool) {
	if address.Origin.Source == EntityOriginRecordingRoot {
		for _, session := range graph.Sessions {
			if session.ID == graph.RootSessionID ||
				session.Kind == "root" {
				return session, true
			}
		}
		return agenthost.HistoricalSession{}, false
	}
	binding, ok := entities.binding(address)
	if !ok {
		return agenthost.HistoricalSession{}, false
	}
	for _, session := range graph.Sessions {
		if session.ID == binding.SessionID {
			return session, true
		}
	}
	return agenthost.HistoricalSession{}, false
}
