package activityreplication

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"

	"github.com/tutti-os/tutti/packages/agent/store-sqlite/canonical"
)

const (
	VisibilityMembers = "members"
	VisibilityPublic  = "public"
)

var (
	ErrInvalidBatch    = errors.New("invalid activity replication batch")
	ErrInvalidMutation = errors.New("invalid activity replication mutation")
)

func ValidateBatch(batch ChangeBatch) error {
	if batch.SchemaVersion != SchemaVersion || len(batch.Mutations) == 0 || len(batch.Mutations) > MaxBatchMutations {
		if len(batch.Mutations) > 0 {
			return NewPermanentRejection(RejectionSchema, batch.Mutations[0], ErrInvalidBatch)
		}
		return ErrInvalidBatch
	}
	for index := range batch.Mutations {
		if err := ValidateMutation(batch.Mutations[index]); err != nil {
			return err
		}
	}
	return nil
}

func ValidateMutation(mutation Mutation) error {
	if err := validateMutation(mutation); err != nil {
		return NewPermanentRejection(RejectionSchema, mutation, fmt.Errorf("%w: %v", ErrInvalidMutation, err))
	}
	return nil
}

func validateMutation(mutation Mutation) error {
	if mutation.SchemaVersion != SchemaVersion || strings.TrimSpace(mutation.MutationID) == "" ||
		strings.TrimSpace(mutation.TransactionID) == "" || strings.TrimSpace(mutation.SourceDeviceID) == "" ||
		strings.TrimSpace(mutation.WorkspaceID) == "" {
		return errors.New("schema and mutation identity are required")
	}
	if mutation.Operation != OperationUpsert && mutation.Operation != OperationDelete {
		return errors.New("operation is not supported")
	}
	if mutation.Operation == OperationDelete {
		if mutation.payloadCount() != 0 || mutation.TargetScope != nil || mutation.SessionScope != nil || !mutation.Key.validFor(mutation.EntityType) {
			return errors.New("delete must contain only its matching typed key")
		}
		return nil
	}
	if mutation.EntityType.isLegacyCommandState() {
		return errors.New("local command-state entities may only be deleted")
	}
	if mutation.payloadCount() != 1 || !mutation.Key.validFor(mutation.EntityType) {
		return errors.New("upsert must contain exactly one matching snapshot")
	}
	switch mutation.EntityType {
	case EntityTarget:
		if !validTargetMutation(mutation) {
			return errors.New("target snapshot is invalid")
		}
	case EntitySession:
		if !validSessionMutation(mutation) {
			return errors.New("session snapshot is invalid")
		}
	case EntityTurn:
		if !validTurnMutation(mutation) {
			return errors.New("turn snapshot is invalid")
		}
	case EntityInteraction:
		if !validInteractionMutation(mutation) {
			return errors.New("interaction snapshot is invalid")
		}
	case EntityMessage:
		if !validMessageMutation(mutation) {
			return errors.New("message snapshot is invalid")
		}
	default:
		return errors.New("entity type is not supported")
	}
	return nil
}

func (mutation Mutation) payloadCount() int {
	count := 0
	for _, present := range []bool{
		mutation.Target != nil,
		mutation.Session != nil,
		mutation.Turn != nil,
		mutation.Interaction != nil,
		mutation.Message != nil,
	} {
		if present {
			count++
		}
	}
	return count
}

func (entityType EntityType) isLegacyCommandState() bool {
	return entityType == EntityRuntimeOperation || entityType == EntityRuntimeOperationEvent || entityType == EntitySubmitClaim
}

func (key EntityKey) validFor(entityType EntityType) bool {
	required := func(values ...string) bool {
		for _, value := range values {
			if strings.TrimSpace(value) == "" {
				return false
			}
		}
		return true
	}
	switch entityType {
	case EntityTarget:
		return required(key.AgentTargetID) && key.only("target")
	case EntitySession:
		return required(key.AgentSessionID) && key.only("session")
	case EntityTurn:
		return required(key.AgentSessionID, key.TurnID) && key.only("turn")
	case EntityInteraction:
		return required(key.AgentSessionID, key.TurnID, key.RequestID) && key.only("interaction")
	case EntityMessage:
		return required(key.AgentSessionID, key.MessageID) && key.only("message")
	case EntityRuntimeOperation:
		return required(key.AgentSessionID, key.OperationID) && key.only("runtimeOperation")
	case EntityRuntimeOperationEvent:
		return required(key.AgentSessionID, key.OperationID, key.EventKind) && key.only("runtimeOperationEvent")
	case EntitySubmitClaim:
		return required(key.AgentSessionID, key.ClientSubmitID) && key.only("submitClaim")
	default:
		return false
	}
}

func (key EntityKey) only(kind string) bool {
	allowed := map[string]bool{}
	switch kind {
	case "target":
		allowed["target"] = true
	case "session":
		allowed["session"] = true
	case "turn":
		allowed["session"], allowed["turn"] = true, true
	case "interaction":
		allowed["session"], allowed["turn"], allowed["request"] = true, true, true
	case "message":
		allowed["session"], allowed["message"] = true, true
	case "runtimeOperation":
		allowed["session"], allowed["operation"] = true, true
	case "runtimeOperationEvent":
		allowed["session"], allowed["operation"], allowed["event"] = true, true, true
	case "submitClaim":
		allowed["session"], allowed["submit"] = true, true
	}
	values := map[string]string{
		"target": key.AgentTargetID, "session": key.AgentSessionID, "turn": key.TurnID,
		"request": key.RequestID, "message": key.MessageID, "operation": key.OperationID,
		"event": key.EventKind, "submit": key.ClientSubmitID,
	}
	for name, value := range values {
		if !allowed[name] && value != "" {
			return false
		}
	}
	return true
}

func validTargetMutation(mutation Mutation) bool {
	target, scope := mutation.Target, mutation.TargetScope
	return target != nil && scope != nil && mutation.SessionScope == nil && target.ID == mutation.Key.AgentTargetID &&
		strings.TrimSpace(scope.OwnerUserID) != "" && strings.TrimSpace(scope.OwnerDeviceID) == strings.TrimSpace(mutation.SourceDeviceID) &&
		jsonObject(target.LaunchRef) && nonnegative(target.CreatedAtUnixMS, target.UpdatedAtUnixMS)
}

func validSessionMutation(mutation Mutation) bool {
	session, scope := mutation.Session, mutation.SessionScope
	if session == nil || scope == nil || mutation.TargetScope != nil || session.WorkspaceID != mutation.WorkspaceID ||
		session.AgentSessionID != mutation.Key.AgentSessionID || strings.TrimSpace(session.RailSectionKey) == "" ||
		strings.TrimSpace(scope.ExecutorOwnerUserID) == "" || strings.TrimSpace(scope.SourceDeviceID) != strings.TrimSpace(mutation.SourceDeviceID) ||
		(scope.Visibility != VisibilityMembers && scope.Visibility != VisibilityPublic) || !validSessionRelation(session) ||
		!jsonObject(session.Settings) || !jsonObject(session.SessionMetadata) || !jsonObject(session.InternalRuntimeContext) {
		return false
	}
	return nonnegative(session.LastEventAtUnixMS, session.StartedAtUnixMS, session.EndedAtUnixMS, session.PinnedAtUnixMS,
		session.DeletedAtUnixMS, session.CreatedAtUnixMS, session.UpdatedAtUnixMS)
}

func validSessionRelation(session *Session) bool {
	if session.Kind == canonical.SessionKindRoot {
		return session.RootAgentSessionID == nil && session.RootTurnID == nil && session.ParentAgentSessionID == nil &&
			session.ParentTurnID == nil && session.ParentToolCallID == nil
	}
	if session.Kind != canonical.SessionKindChild {
		return false
	}
	for _, value := range []*string{session.RootAgentSessionID, session.RootTurnID, session.ParentAgentSessionID, session.ParentTurnID, session.ParentToolCallID} {
		if value == nil || strings.TrimSpace(*value) == "" {
			return false
		}
	}
	return *session.RootAgentSessionID != session.AgentSessionID && *session.ParentAgentSessionID != session.AgentSessionID
}

func validTurnMutation(mutation Mutation) bool {
	turn, scope := mutation.Turn, mutation.SessionScope
	if turn == nil || scope == nil || mutation.TargetScope != nil || turn.WorkspaceID != mutation.WorkspaceID ||
		turn.AgentSessionID != mutation.Key.AgentSessionID || turn.TurnID != mutation.Key.TurnID ||
		!canonical.IsKnownTurnPhase(turn.Phase) || !canonical.IsKnownTurnOrigin(turn.Origin) ||
		!jsonObjectOrNull(turn.Error) || !jsonObjectOrNull(turn.FileChanges) || !jsonObjectOrNull(turn.CompletedCommand) ||
		!jsonObjectOrNull(turn.RootProviderTurnError) || !jsonObjectOrNull(turn.RootProviderTurnCompletedCommand) ||
		!validSessionScope(scope, mutation.SourceDeviceID) {
		return false
	}
	if turn.Outcome != nil && !canonical.IsKnownTurnOutcome(*turn.Outcome) {
		return false
	}
	if turn.Phase == canonical.TurnPhaseSettled {
		if turn.Outcome == nil || turn.SettledAtUnixMS == nil {
			return false
		}
	} else if turn.Outcome != nil || turn.SettledAtUnixMS != nil {
		return false
	}
	if turn.SourceGoalOperationID == nil && (turn.SourceGoalRevision != nil || turn.SourceGoalRepairEpoch != nil) {
		return false
	}
	if turn.RootProviderTurnPhase != nil && *turn.RootProviderTurnPhase != canonical.RootProviderTurnPhaseRunning &&
		*turn.RootProviderTurnPhase != canonical.RootProviderTurnPhaseCompleted {
		return false
	}
	if turn.RootProviderTurnOutcome != nil && !canonical.IsKnownTurnOutcome(*turn.RootProviderTurnOutcome) {
		return false
	}
	return nonnegative(turn.StartedAtUnixMS, turn.CreatedAtUnixMS, turn.UpdatedAtUnixMS, turn.RootProviderTurnUpdatedAtUnixMS) &&
		(turn.SettledAtUnixMS == nil || *turn.SettledAtUnixMS >= 0)
}

func validInteractionMutation(mutation Mutation) bool {
	interaction, scope := mutation.Interaction, mutation.SessionScope
	return interaction != nil && scope != nil && mutation.TargetScope == nil && interaction.WorkspaceID == mutation.WorkspaceID &&
		interaction.AgentSessionID == mutation.Key.AgentSessionID && interaction.TurnID == mutation.Key.TurnID &&
		interaction.RequestID == mutation.Key.RequestID && canonical.IsKnownInteractionKind(interaction.Kind) &&
		canonical.IsKnownInteractionStatus(interaction.Status) && interaction.CreatedAtUnixMS >= 0 &&
		interaction.UpdatedAtUnixMS >= interaction.CreatedAtUnixMS && jsonObject(interaction.Input) &&
		jsonObject(interaction.Output) && jsonObject(interaction.Metadata) && validSessionScope(scope, mutation.SourceDeviceID)
}

func validMessageMutation(mutation Mutation) bool {
	message, scope := mutation.Message, mutation.SessionScope
	return message != nil && scope != nil && mutation.TargetScope == nil && message.WorkspaceID == mutation.WorkspaceID &&
		message.AgentSessionID == mutation.Key.AgentSessionID && message.MessageID == mutation.Key.MessageID && message.Version > 0 &&
		strings.TrimSpace(message.Role) != "" && strings.TrimSpace(message.Kind) != "" &&
		(message.TurnID == nil || strings.TrimSpace(*message.TurnID) != "") && jsonObjectOrNull(message.Semantics) &&
		jsonObject(message.Payload) && nonnegative(message.OccurredAtUnixMS, message.StartedAtUnixMS, message.CompletedAtUnixMS,
		message.DeletedAtUnixMS, message.CreatedAtUnixMS, message.UpdatedAtUnixMS) && validSessionScope(scope, mutation.SourceDeviceID)
}

func validSessionScope(scope *SessionScope, sourceDeviceID string) bool {
	return scope != nil && strings.TrimSpace(scope.ExecutorOwnerUserID) != "" &&
		strings.TrimSpace(scope.SourceDeviceID) == strings.TrimSpace(sourceDeviceID) &&
		(scope.Visibility == VisibilityMembers || scope.Visibility == VisibilityPublic)
}

func jsonObject(raw json.RawMessage) bool {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var value map[string]any
	if decoder.Decode(&value) != nil || value == nil {
		return false
	}
	return decoder.Decode(&struct{}{}) == io.EOF
}

func jsonObjectOrNull(raw json.RawMessage) bool {
	return len(raw) == 0 || strings.TrimSpace(string(raw)) == "null" || jsonObject(raw)
}

func nonnegative(values ...int64) bool {
	for _, value := range values {
		if value < 0 {
			return false
		}
	}
	return true
}
