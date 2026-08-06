package sessionreplay

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"sort"
	"strings"
)

const (
	CheckpointPlanSchemaVersion = 2
	ObservationSchemaVersion    = 2
)

type ProviderInputUnitKind string

const (
	ProviderInputUnitProtocolMessage ProviderInputUnitKind = "protocol-message"
	ProviderInputUnitMappedStderr    ProviderInputUnitKind = "mapped-stderr-message"
	ProviderInputUnitProcessExit     ProviderInputUnitKind = "process-exit"
)

type ProviderUnitPosition struct {
	ConnectionID string `json:"connectionId"`
	ChunkSeq     uint64 `json:"chunkSeq"`
	UnitIndex    uint64 `json:"unitIndex"`
}

type ProviderObservationPosition struct {
	ConnectionID string `json:"connectionId"`
	ChunkSeq     uint64 `json:"chunkSeq"`
	UnitIndex    uint64 `json:"unitIndex"`
	EventIndex   uint64 `json:"eventIndex"`
}

type ReplayCursor struct {
	ActivityEventSequence uint64                 `json:"activityEventSequence"`
	ProviderConnections   []ProviderUnitPosition `json:"providerConnections"`
}

type CheckpointTriggerSource string

const (
	CheckpointTriggerBootstrap           CheckpointTriggerSource = "bootstrap"
	CheckpointTriggerActivityBoundary    CheckpointTriggerSource = "activity-boundary"
	CheckpointTriggerProviderObservation CheckpointTriggerSource = "provider-observation"
)

type ActivityBoundaryKind string

const (
	ActivityBoundaryIntentEffects ActivityBoundaryKind = "intent-effects"
	ActivityBoundarySingleEvent   ActivityBoundaryKind = "single-event"
)

type CheckpointTrigger struct {
	Source                     CheckpointTriggerSource      `json:"source"`
	AfterActivityEventSequence uint64                       `json:"afterActivityEventSequence,omitempty"`
	BoundaryKind               ActivityBoundaryKind         `json:"boundaryKind,omitempty"`
	Position                   *ProviderObservationPosition `json:"position,omitempty"`
	UnitKind                   ProviderInputUnitKind        `json:"unitKind,omitempty"`
	Type                       string                       `json:"type,omitempty"`
	Fingerprint                string                       `json:"fingerprint,omitempty"`
}

type ReadinessPredicate struct {
	Type    string `json:"type"`
	Subject int    `json:"subject"`
	Equals  string `json:"equals"`
}

type CheckpointReadiness struct {
	All []ReadinessPredicate `json:"all"`
}

type ReplayCheckpoint struct {
	ID        string              `json:"id"`
	Index     int                 `json:"index"`
	Kind      string              `json:"kind"`
	Tags      []string            `json:"tags"`
	Cursor    ReplayCursor        `json:"cursor"`
	Trigger   CheckpointTrigger   `json:"trigger"`
	Subjects  []EntityAddress     `json:"subjects"`
	Readiness CheckpointReadiness `json:"readiness"`
}

type CheckpointPlan struct {
	SchemaVersion            int                `json:"schemaVersion"`
	CassetteSchemaVersion    int                `json:"cassetteSchemaVersion"`
	ObservationSchemaVersion int                `json:"observationSchemaVersion"`
	Checkpoints              []ReplayCheckpoint `json:"checkpoints"`
}

func AppendCheckpoint(plan *CheckpointPlan, checkpoint ReplayCheckpoint) {
	if plan == nil {
		return
	}
	if len(plan.Checkpoints) > 0 {
		last := len(plan.Checkpoints) - 1
		if replayCursorEqual(plan.Checkpoints[last].Cursor, checkpoint.Cursor) {
			plan.Checkpoints[last] = MergeCheckpointCandidate(
				plan.Checkpoints[last],
				checkpoint,
			)
			return
		}
		// Deny/cancel activity boundaries can arrive after a provider turn
		// terminal already closed the plan. Fold interaction.resolved into
		// that terminal so the published final stays a true terminal kind.
		if isPublishedTerminalKind(plan.Checkpoints[last].Kind) &&
			isPostTerminalInteractionKind(checkpoint.Kind) {
			merged := MergeCheckpointCandidate(
				plan.Checkpoints[last],
				checkpoint,
			)
			merged.Kind = plan.Checkpoints[last].Kind
			merged.Trigger = plan.Checkpoints[last].Trigger
			if !slices.Contains(merged.Tags, merged.Kind) {
				merged.Tags = append(merged.Tags, merged.Kind)
			}
			plan.Checkpoints[last] = merged
			return
		}
	}
	checkpoint.Index = len(plan.Checkpoints)
	checkpoint.ID = fmt.Sprintf("checkpoint-%04d", checkpoint.Index)
	plan.Checkpoints = append(plan.Checkpoints, checkpoint)
}

func MergeCheckpointCandidate(
	left, right ReplayCheckpoint,
) ReplayCheckpoint {
	for _, tag := range right.Tags {
		if !slices.Contains(left.Tags, tag) {
			left.Tags = append(left.Tags, tag)
		}
	}
	rightIndexes := make(map[int]int, len(right.Subjects))
	for index, subject := range right.Subjects {
		target := entityAddressIndex(left.Subjects, subject)
		if target < 0 {
			target = len(left.Subjects)
			left.Subjects = append(left.Subjects, subject)
		}
		rightIndexes[index] = target
	}
	for _, predicate := range right.Readiness.All {
		target, ok := rightIndexes[predicate.Subject]
		if !ok {
			target = -1
		}
		predicate.Subject = target
		left.Readiness.All = append(left.Readiness.All, predicate)
	}
	if checkpointKindPriority(right.Kind) > checkpointKindPriority(left.Kind) {
		left.Kind = right.Kind
		left.Trigger = right.Trigger
	}
	left.Cursor = right.Cursor
	return left
}

func replayCursorEqual(left, right ReplayCursor) bool {
	return left.ActivityEventSequence == right.ActivityEventSequence &&
		slices.Equal(left.ProviderConnections, right.ProviderConnections)
}

func checkpointKindPriority(kind string) int {
	switch kind {
	// Published terminals outrank co-located tool/interaction kinds so a
	// deny/cancel unit that carries both call.failed and turn.completed
	// keeps turn.terminal as the primary kind (ValidatePublishedCheckpointPlan).
	case "turn.terminal", "turn.canceled",
		"goal.completed", "goal.cleared",
		"child-session.completed":
		return 60
	// Compaction notices often share the Claude acceptance unit with
	// root_provider_turn.started (held /compact banners restamped onto the
	// identity chunk). Keep turn.working as the primary trigger so replay can
	// match the started observation; compaction stays in tags/readiness.
	case "compaction.completed", "compaction.canceled":
		return 8
	case "interaction.pending", "interaction.superseded":
		return 50
	case "plan.waiting":
		return 45
	case "tool.completed":
		return 40
	case "tool.started":
		return 30
	case "turn.working":
		return 10
	case "project.binding-ready":
		return 5
	default:
		return 0
	}
}

func isPublishedTerminalKind(kind string) bool {
	switch kind {
	case "turn.terminal", "turn.canceled", "goal.completed", "goal.cleared",
		"child-session.completed", "compaction.completed",
		"compaction.canceled":
		return true
	default:
		return false
	}
}

func isPostTerminalInteractionKind(kind string) bool {
	switch kind {
	case "interaction.resolved", "interaction.superseded":
		return true
	default:
		return false
	}
}

type ProviderObservation struct {
	SchemaVersion int            `json:"schemaVersion"`
	Type          string         `json:"type"`
	Address       EntityAddress  `json:"address"`
	Stable        map[string]any `json:"stable,omitempty"`
}

type ObservationJournalEntry struct {
	SchemaVersion int                           `json:"schemaVersion"`
	Position      ProviderUnitPosition          `json:"position"`
	UnitKind      ProviderInputUnitKind         `json:"unitKind"`
	Observations  []JournalObservation          `json:"observations"`
	Correlations  []CheckpointCommitCorrelation `json:"commitCorrelations"`
}

type JournalObservation struct {
	Position    ProviderObservationPosition `json:"position"`
	Type        string                      `json:"type"`
	Fingerprint string                      `json:"fingerprint"`
	Address     EntityAddress               `json:"address"`
}

type CheckpointCommitCorrelation struct {
	ID                     string                      `json:"id"`
	Kind                   string                      `json:"kind"`
	Address                EntityAddress               `json:"address"`
	ObservationPosition    ProviderObservationPosition `json:"observationPosition"`
	ObservationFingerprint string                      `json:"observationFingerprint"`
	Expected               string                      `json:"expected"`
	Confirmed              bool                        `json:"confirmed"`
	TransactionID          string                      `json:"transactionId,omitempty"`
}

var supportedCheckpointKinds = map[string]struct{}{
	"replay.bootstrap": {}, "session.ready": {}, "turn.working": {},
	"turn.canceled": {},
	"turn.terminal": {}, "interaction.pending": {},
	"interaction.resolved": {}, "interaction.superseded": {},
	"plan.waiting": {}, "plan.feedback-submitted": {},
	"plan.confirmed": {}, "plan.superseded": {}, "tool.started": {},
	"tool.completed": {}, "queue.stable": {},
	"settings.applied": {}, "submission.accepted": {},
	"response.committed": {}, "goal.running": {}, "goal.paused": {},
	"goal.completed": {}, "goal.cleared": {}, "compaction.running": {},
	"compaction.canceled": {}, "compaction.completed": {},
	"child-session.running": {}, "child-session.completed": {},
	"attachment.materialized": {}, "project.binding-ready": {},
}

var supportedReadinessPredicates = map[string]struct{}{
	"session.exists": {}, "session.status": {}, "session.queue-empty": {},
	"turn.phase":  {},
	"turn.status": {}, "interaction.status": {}, "call.status": {},
	"plan.status": {}, "goal.status": {}, "settings.equal": {},
	"attachment.materialized": {}, "compaction.status": {},
	"child-session.status": {}, "project.binding": {},
}

func NewCheckpointPlan(checkpoints []ReplayCheckpoint) CheckpointPlan {
	return CheckpointPlan{
		SchemaVersion:            CheckpointPlanSchemaVersion,
		CassetteSchemaVersion:    CassetteSchemaVersion,
		ObservationSchemaVersion: ObservationSchemaVersion,
		Checkpoints:              checkpoints,
	}
}

func ObservationFingerprint(observation ProviderObservation) (string, error) {
	if observation.SchemaVersion != ObservationSchemaVersion ||
		strings.TrimSpace(observation.Type) == "" {
		return "", errors.New("provider observation is invalid")
	}
	if err := ValidateEntityAddress(observation.Address); err != nil {
		return "", err
	}
	canonical, err := json.Marshal(observation)
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256(canonical)
	return "sha256:" + hex.EncodeToString(digest[:]), nil
}

func ValidateCheckpointPlan(
	plan CheckpointPlan,
	connectionIDs []string,
	activityEvents []ActivityEvent,
) error {
	if plan.SchemaVersion != CheckpointPlanSchemaVersion ||
		plan.CassetteSchemaVersion != CassetteSchemaVersion ||
		plan.ObservationSchemaVersion != ObservationSchemaVersion {
		return errors.New("checkpoint plan has unsupported schema version")
	}
	if len(plan.Checkpoints) == 0 {
		return errors.New("checkpoint plan has no checkpoints")
	}
	knownConnections := make(map[string]struct{}, len(connectionIDs))
	for _, connectionID := range connectionIDs {
		connectionID = strings.TrimSpace(connectionID)
		if connectionID == "" {
			return errors.New("provider connection id is empty")
		}
		knownConnections[connectionID] = struct{}{}
	}
	if activityEvents != nil {
		if err := ValidateActivityTimelineComplete(activityEvents); err != nil {
			return err
		}
	}
	ids := make(map[string]struct{}, len(plan.Checkpoints))
	previous := ReplayCursor{}
	for index, checkpoint := range plan.Checkpoints {
		if checkpoint.Index != index ||
			checkpoint.ID != fmt.Sprintf("checkpoint-%04d", index) {
			return fmt.Errorf("checkpoint index or id is not contiguous at %d", index)
		}
		if _, duplicate := ids[checkpoint.ID]; duplicate {
			return fmt.Errorf("checkpoint id %q is duplicated", checkpoint.ID)
		}
		ids[checkpoint.ID] = struct{}{}
		if _, ok := supportedCheckpointKinds[checkpoint.Kind]; !ok {
			return fmt.Errorf("checkpoint %q has unsupported kind %q", checkpoint.ID, checkpoint.Kind)
		}
		if !slices.Contains(checkpoint.Tags, checkpoint.Kind) {
			return fmt.Errorf("checkpoint %q primary kind is absent from tags", checkpoint.ID)
		}
		if err := validateReplayCursor(checkpoint.Cursor, previous, knownConnections); err != nil {
			return fmt.Errorf("checkpoint %q: %w", checkpoint.ID, err)
		}
		if index > 0 && equalReplayCursor(checkpoint.Cursor, previous) {
			return fmt.Errorf("checkpoint %q must be coalesced with the previous cursor", checkpoint.ID)
		}
		if err := validateCheckpointTrigger(checkpoint.Trigger, checkpoint.Cursor, activityEvents); err != nil {
			return fmt.Errorf("checkpoint %q: %w", checkpoint.ID, err)
		}
		for subjectIndex, subject := range checkpoint.Subjects {
			if err := ValidateEntityAddress(subject); err != nil {
				return fmt.Errorf("checkpoint %q: %w", checkpoint.ID, err)
			}
			if entityAddressIndex(checkpoint.Subjects[:subjectIndex], subject) >= 0 {
				return fmt.Errorf(
					"checkpoint %q has duplicate entity address",
					checkpoint.ID,
				)
			}
		}
		for _, predicate := range checkpoint.Readiness.All {
			if _, ok := supportedReadinessPredicates[predicate.Type]; !ok {
				return fmt.Errorf("checkpoint %q has unsupported readiness %q", checkpoint.ID, predicate.Type)
			}
			if predicate.Subject < 0 || predicate.Subject >= len(checkpoint.Subjects) {
				return fmt.Errorf("checkpoint %q readiness subject is out of range", checkpoint.ID)
			}
			if strings.TrimSpace(predicate.Equals) == "" {
				return fmt.Errorf("checkpoint %q readiness has empty expected value", checkpoint.ID)
			}
		}
		previous = checkpoint.Cursor
	}
	if plan.Checkpoints[0].Trigger.Source != CheckpointTriggerBootstrap {
		return errors.New("checkpoint zero must use bootstrap trigger")
	}
	return nil
}

func ValidateCheckpointJournalAnchors(
	plan CheckpointPlan,
	entries []ObservationJournalEntry,
) error {
	observations := make(map[ProviderObservationPosition]JournalObservation)
	correlations := make(map[ProviderUnitPosition][]CheckpointCommitCorrelation)
	for _, entry := range entries {
		if entry.SchemaVersion != ObservationSchemaVersion ||
			entry.Position.ConnectionID == "" ||
			entry.Position.ChunkSeq == 0 ||
			entry.Position.UnitIndex == 0 {
			return errors.New("observation journal entry is invalid")
		}
		switch entry.UnitKind {
		case ProviderInputUnitProtocolMessage, ProviderInputUnitMappedStderr,
			ProviderInputUnitProcessExit:
		default:
			return errors.New("observation journal unit kind is invalid")
		}
		for _, observation := range entry.Observations {
			if observation.Position.ConnectionID != entry.Position.ConnectionID ||
				observation.Position.ChunkSeq != entry.Position.ChunkSeq ||
				observation.Position.UnitIndex != entry.Position.UnitIndex ||
				observation.Position.EventIndex == 0 ||
				strings.TrimSpace(observation.Type) == "" ||
				!validObservationFingerprint(observation.Fingerprint) {
				return errors.New("observation journal anchor is invalid")
			}
			if err := ValidateEntityAddress(observation.Address); err != nil {
				return fmt.Errorf("observation journal address is invalid: %w", err)
			}
			if _, duplicate := observations[observation.Position]; duplicate {
				return errors.New("observation journal anchor is duplicated")
			}
			observations[observation.Position] = observation
		}
		for _, correlation := range entry.Correlations {
			if err := ValidateEntityAddress(correlation.Address); err != nil {
				return fmt.Errorf(
					"observation journal commit correlation is invalid: %w",
					err,
				)
			}
			if correlation.ObservationPosition.ConnectionID !=
				entry.Position.ConnectionID ||
				correlation.ObservationPosition.ChunkSeq !=
					entry.Position.ChunkSeq ||
				correlation.ObservationPosition.UnitIndex !=
					entry.Position.UnitIndex ||
				correlation.ObservationPosition.EventIndex == 0 ||
				!validObservationFingerprint(
					correlation.ObservationFingerprint,
				) {
				return errors.New(
					"observation journal commit correlation identity is invalid",
				)
			}
		}
		correlations[entry.Position] = append(
			correlations[entry.Position],
			entry.Correlations...,
		)
	}
	for _, checkpoint := range plan.Checkpoints {
		if checkpoint.Trigger.Source != CheckpointTriggerProviderObservation {
			continue
		}
		trigger := checkpoint.Trigger
		observation, ok := observations[*trigger.Position]
		if !ok {
			return fmt.Errorf(
				"checkpoint_trigger_missing: checkpoint %q has no observation anchor",
				checkpoint.ID,
			)
		}
		if observation.Type != trigger.Type ||
			observation.Fingerprint != trigger.Fingerprint {
			return fmt.Errorf(
				"checkpoint_trigger_mismatch: checkpoint %q observation differs",
				checkpoint.ID,
			)
		}
		position := ProviderUnitPosition{
			ConnectionID: trigger.Position.ConnectionID,
			ChunkSeq:     trigger.Position.ChunkSeq,
			UnitIndex:    trigger.Position.UnitIndex,
		}
		if entityAddressIndex(checkpoint.Subjects, observation.Address) < 0 {
			return fmt.Errorf(
				"checkpoint_trigger_mismatch: checkpoint %q omits observation address",
				checkpoint.ID,
			)
		}
		selectedCorrelations := correlations[position]
		confirmed := false
		for _, correlation := range selectedCorrelations {
			if err := ValidateEntityAddress(correlation.Address); err != nil {
				return fmt.Errorf(
					"checkpoint_commit_invalid: checkpoint %q correlation %q: %w",
					checkpoint.ID,
					correlation.ID,
					err,
				)
			}
			if !entityAddressEqual(correlation.Address, observation.Address) {
				continue
			}
			if correlation.ObservationPosition != observation.Position ||
				correlation.ObservationFingerprint != observation.Fingerprint {
				continue
			}
			if strings.TrimSpace(correlation.ID) != "" &&
				strings.TrimSpace(correlation.Kind) != "" &&
				strings.TrimSpace(correlation.Expected) != "" &&
				correlation.Confirmed &&
				strings.TrimSpace(correlation.TransactionID) != "" {
				confirmed = true
				break
			}
		}
		if !confirmed {
			return fmt.Errorf(
				"checkpoint_commit_unconfirmed: checkpoint %q has no exact commit correlation",
				checkpoint.ID,
			)
		}
	}
	return nil
}

func ValidatePublishedCheckpointPlan(plan CheckpointPlan) error {
	if len(plan.Checkpoints) == 0 {
		return errors.New("checkpoint plan has no checkpoints")
	}
	last := plan.Checkpoints[len(plan.Checkpoints)-1]
	if isPublishedTerminalKind(last.Kind) {
		return nil
	}
	return fmt.Errorf(
		"checkpoint_plan_invalid: final checkpoint %q is not terminal",
		last.ID,
	)
}

func validateReplayCursor(
	cursor, previous ReplayCursor,
	knownConnections map[string]struct{},
) error {
	if cursor.ActivityEventSequence < previous.ActivityEventSequence {
		return errors.New("activity cursor moved backward")
	}
	current := make(map[string]ProviderUnitPosition, len(cursor.ProviderConnections))
	lastID := ""
	for _, position := range cursor.ProviderConnections {
		if position.ConnectionID == "" || position.ConnectionID <= lastID {
			return errors.New("provider cursor connections must be unique and sorted")
		}
		if len(knownConnections) > 0 {
			if _, ok := knownConnections[position.ConnectionID]; !ok {
				return fmt.Errorf("provider cursor references unknown connection %q", position.ConnectionID)
			}
		}
		current[position.ConnectionID] = position
		lastID = position.ConnectionID
	}
	for _, old := range previous.ProviderConnections {
		next, ok := current[old.ConnectionID]
		if !ok {
			return fmt.Errorf("provider cursor dropped connection %q", old.ConnectionID)
		}
		if compareProviderUnitPosition(next, old) < 0 {
			return fmt.Errorf("provider cursor moved backward for %q", old.ConnectionID)
		}
	}
	return nil
}

func validateCheckpointTrigger(
	trigger CheckpointTrigger,
	cursor ReplayCursor,
	events []ActivityEvent,
) error {
	switch trigger.Source {
	case CheckpointTriggerBootstrap:
		if trigger.Position != nil || trigger.AfterActivityEventSequence != 0 {
			return errors.New("bootstrap trigger has a position")
		}
	case CheckpointTriggerActivityBoundary:
		if trigger.AfterActivityEventSequence == 0 ||
			trigger.AfterActivityEventSequence != cursor.ActivityEventSequence {
			return errors.New("activity trigger does not equal its cursor")
		}
		if trigger.BoundaryKind != ActivityBoundaryIntentEffects &&
			trigger.BoundaryKind != ActivityBoundarySingleEvent {
			return errors.New("activity trigger has unsupported boundary kind")
		}
		if events != nil {
			if trigger.AfterActivityEventSequence > uint64(len(events)) {
				return errors.New("activity trigger exceeds the event stream")
			}
			if splitsIntentEffects(trigger.AfterActivityEventSequence, events) {
				return errors.New("activity trigger splits an intent from its effects")
			}
		}
	case CheckpointTriggerProviderObservation:
		if trigger.Position == nil || strings.TrimSpace(trigger.Type) == "" ||
			!validObservationFingerprint(trigger.Fingerprint) {
			return errors.New("provider observation trigger is incomplete")
		}
		switch trigger.UnitKind {
		case ProviderInputUnitProtocolMessage, ProviderInputUnitMappedStderr,
			ProviderInputUnitProcessExit:
		default:
			return errors.New("provider observation trigger has unsupported unit kind")
		}
		cursorPosition, ok := providerCursorPosition(cursor, trigger.Position.ConnectionID)
		if !ok || compareProviderUnitPosition(ProviderUnitPosition{
			ConnectionID: trigger.Position.ConnectionID,
			ChunkSeq:     trigger.Position.ChunkSeq,
			UnitIndex:    trigger.Position.UnitIndex,
		}, cursorPosition) > 0 || trigger.Position.EventIndex == 0 {
			return errors.New("provider observation trigger exceeds its lane cursor")
		}
	default:
		return fmt.Errorf("unsupported checkpoint trigger %q", trigger.Source)
	}
	return nil
}

func splitsIntentEffects(sequence uint64, events []ActivityEvent) bool {
	if sequence == 0 || sequence >= uint64(len(events)) {
		return false
	}
	included := make(map[string]struct{}, sequence)
	for _, event := range events[:sequence] {
		included[event.EventID] = struct{}{}
	}
	for _, event := range events[sequence:] {
		if event.Kind == ActivityEventKindEffect {
			if _, ok := included[event.CausedByEventID]; ok {
				return true
			}
		}
	}
	return false
}

func providerCursorPosition(cursor ReplayCursor, connectionID string) (ProviderUnitPosition, bool) {
	index, found := sort.Find(len(cursor.ProviderConnections), func(index int) int {
		return strings.Compare(cursor.ProviderConnections[index].ConnectionID, connectionID)
	})
	if !found {
		return ProviderUnitPosition{}, false
	}
	return cursor.ProviderConnections[index], true
}

func compareProviderUnitPosition(left, right ProviderUnitPosition) int {
	if left.ChunkSeq != right.ChunkSeq {
		if left.ChunkSeq < right.ChunkSeq {
			return -1
		}
		return 1
	}
	if left.UnitIndex < right.UnitIndex {
		return -1
	}
	if left.UnitIndex > right.UnitIndex {
		return 1
	}
	return 0
}

func equalReplayCursor(left, right ReplayCursor) bool {
	return left.ActivityEventSequence == right.ActivityEventSequence &&
		slices.Equal(left.ProviderConnections, right.ProviderConnections)
}

func entityAddressIndex(addresses []EntityAddress, target EntityAddress) int {
	for index, address := range addresses {
		if entityAddressEqual(address, target) {
			return index
		}
	}
	return -1
}

func validObservationFingerprint(value string) bool {
	digest, ok := strings.CutPrefix(strings.TrimSpace(value), "sha256:")
	if !ok {
		return false
	}
	decoded, err := hex.DecodeString(digest)
	return err == nil && len(decoded) == sha256.Size
}
