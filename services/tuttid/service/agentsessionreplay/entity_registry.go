package agentsessionreplay

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"

	replay "github.com/tutti-os/tutti/packages/agent/session-replay"
	replaybiz "github.com/tutti-os/tutti/services/tuttid/biz/agentsessionreplay"
)

type replayEntityBinding struct {
	SessionID       string
	TurnID          string
	EntityID        string
	MessageID       string
	AttachmentIndex uint64
}

type replayEntityRegistry struct {
	rootSessionID string
	byRuntime     map[string]replay.EntityAddress
	byAddress     map[string]replayEntityBinding
}

func newReplayEntityRegistry(rootSessionID string) replayEntityRegistry {
	r := replayEntityRegistry{
		rootSessionID: strings.TrimSpace(rootSessionID),
		byRuntime:     make(map[string]replay.EntityAddress),
		byAddress:     make(map[string]replayEntityBinding),
	}
	if r.rootSessionID != "" {
		_, _ = r.bind(
			sessionRuntimeKey(r.rootSessionID),
			recordingRootAddress(),
			replayEntityBinding{
				SessionID: r.rootSessionID,
				EntityID:  r.rootSessionID,
			},
		)
	}
	return r
}

func (r replayEntityRegistry) clone() replayEntityRegistry {
	out := newReplayEntityRegistry("")
	out.rootSessionID = r.rootSessionID
	for key, address := range r.byRuntime {
		out.byRuntime[key] = address
	}
	for key, binding := range r.byAddress {
		out.byAddress[key] = binding
	}
	return out
}

func recordingRootAddress() replay.EntityAddress {
	return replay.EntityAddress{
		Kind: replay.EntityKindSession,
		Origin: replay.EntityOrigin{
			Source: replay.EntityOriginRecordingRoot,
		},
	}
}

func initialStateAddress(
	kind replay.EntityKind,
	path string,
) replay.EntityAddress {
	return replay.EntityAddress{
		Kind: kind,
		Origin: replay.EntityOrigin{
			Source:           replay.EntityOriginInitialState,
			InitialStatePath: path,
		},
	}
}

func activityAddress(
	kind replay.EntityKind,
	sequence uint64,
	discriminator string,
) replay.EntityAddress {
	return replay.EntityAddress{
		Kind: kind,
		Origin: replay.EntityOrigin{
			Source:                replay.EntityOriginActivityEvent,
			ActivityEventSequence: sequence,
		},
		Discriminator: discriminator,
	}
}

func providerAddress(
	kind replay.EntityKind,
	position replay.ProviderObservationPosition,
	discriminator string,
) replay.EntityAddress {
	return replay.EntityAddress{
		Kind: kind,
		Origin: replay.EntityOrigin{
			Source:              replay.EntityOriginProviderObservation,
			ProviderObservation: &position,
		},
		Discriminator: discriminator,
	}
}

func (r *replayEntityRegistry) bind(
	runtimeKey string,
	address replay.EntityAddress,
	binding replayEntityBinding,
) (replay.EntityAddress, bool) {
	runtimeKey = strings.TrimSpace(runtimeKey)
	if runtimeKey == "" || replay.ValidateEntityAddress(address) != nil {
		return replay.EntityAddress{}, false
	}
	addressKey, err := replay.EntityAddressKey(address)
	if err != nil {
		return replay.EntityAddress{}, false
	}
	if existing, ok := r.byRuntime[runtimeKey]; ok {
		return existing, replay.EntityAddressesEqual(existing, address)
	}
	if existing, ok := r.byAddress[addressKey]; ok &&
		existing != binding {
		return replay.EntityAddress{}, false
	}
	r.byRuntime[runtimeKey] = address
	r.byAddress[addressKey] = binding
	return address, true
}

func (r *replayEntityRegistry) bindFirst(
	runtimeKey string,
	address replay.EntityAddress,
	binding replayEntityBinding,
) (replay.EntityAddress, bool) {
	if existing, ok := r.byRuntime[strings.TrimSpace(runtimeKey)]; ok {
		existingBinding, found := r.binding(existing)
		return existing, found && existingBinding == binding
	}
	return r.bind(runtimeKey, address, binding)
}

func entityParentDiscriminator(address replay.EntityAddress) string {
	key, err := replay.EntityAddressKey(address)
	if err != nil {
		return ""
	}
	return "parent:" + base64.RawURLEncoding.EncodeToString(
		[]byte(key),
	)
}

func parentAddressKey(discriminator string) (string, bool) {
	encoded, ok := strings.CutPrefix(
		strings.TrimSpace(discriminator),
		"parent:",
	)
	if !ok || encoded == "" {
		return "", false
	}
	decoded, err := base64.RawURLEncoding.DecodeString(encoded)
	return string(decoded), err == nil && len(decoded) > 0
}

func (r *replayEntityRegistry) bindActivityAddress(
	address replay.EntityAddress,
) bool {
	if _, ok := r.binding(address); ok {
		return true
	}
	if address.Origin.Source != replay.EntityOriginActivityEvent {
		return false
	}
	parentKey, ok := parentAddressKey(address.Discriminator)
	if !ok {
		return false
	}
	parent, ok := r.byAddress[parentKey]
	if !ok || parent.SessionID == "" {
		return false
	}
	switch address.Kind {
	case replay.EntityKindGoal:
		_, ok = r.bind(
			goalRuntimeKey(parent.SessionID),
			address,
			replayEntityBinding{
				SessionID: parent.SessionID,
				EntityID:  parent.SessionID,
			},
		)
		return ok
	default:
		return false
	}
}

func (r replayEntityRegistry) binding(
	address replay.EntityAddress,
) (replayEntityBinding, bool) {
	key, err := replay.EntityAddressKey(address)
	if err != nil {
		return replayEntityBinding{}, false
	}
	binding, ok := r.byAddress[key]
	return binding, ok
}

func (r replayEntityRegistry) sessionAddress(
	sessionID string,
) (replay.EntityAddress, bool) {
	sessionID = strings.TrimSpace(sessionID)
	if sessionID == "" {
		sessionID = r.rootSessionID
	}
	address, ok := r.byRuntime[sessionRuntimeKey(sessionID)]
	return address, ok
}

func (r replayEntityRegistry) turnAddress(
	sessionID, turnID string,
) (replay.EntityAddress, bool) {
	address, ok := r.byRuntime[turnRuntimeKey(sessionID, turnID)]
	return address, ok
}

func (r replayEntityRegistry) interactionAddress(
	sessionID, turnID, kind, requestID string,
) (replay.EntityAddress, bool) {
	key := interactionRuntimeKey(sessionID, turnID, kind, requestID)
	address, ok := r.byRuntime[key]
	if ok {
		return address, true
	}
	var matched replay.EntityAddress
	matchCount := 0
	for key, candidate := range r.byRuntime {
		binding, found := r.binding(candidate)
		if found &&
			binding.SessionID == strings.TrimSpace(sessionID) &&
			binding.TurnID == strings.TrimSpace(turnID) &&
			binding.EntityID == strings.TrimSpace(requestID) &&
			strings.HasPrefix(key, runtimeKey("interaction")) {
			matched = candidate
			matchCount++
		}
	}
	return matched, matchCount == 1
}

func (r *replayEntityRegistry) seedInitialState(raw []byte) error {
	if len(raw) == 0 {
		return nil
	}
	var state replaybiz.TuttiReplayState
	if err := json.Unmarshal(raw, &state); err != nil {
		return fmt.Errorf("decode replay initial state identities: %w", err)
	}
	return r.seedState(state)
}

func (r *replayEntityRegistry) seedState(
	state replaybiz.TuttiReplayState,
) error {
	for sessionIndex, session := range state.Agent.Sessions {
		sessionPath := fmt.Sprintf("/agent/sessions/%d", sessionIndex)
		sessionAddress := initialStateAddress(
			replay.EntityKindSession,
			sessionPath,
		)
		if session.ID == state.Agent.RootSessionID ||
			session.Kind == "root" {
			sessionAddress = recordingRootAddress()
			if r.rootSessionID == "" {
				r.rootSessionID = session.ID
			}
		}
		if _, ok := r.bindFirst(
			sessionRuntimeKey(session.ID),
			sessionAddress,
			replayEntityBinding{
				SessionID: session.ID,
				EntityID:  session.ID,
			},
		); !ok {
			return fmt.Errorf("bind initial Session %q", session.ID)
		}
		for turnIndex, turn := range session.Turns {
			address := initialStateAddress(
				replay.EntityKindTurn,
				fmt.Sprintf("%s/turns/%d", sessionPath, turnIndex),
			)
			if _, ok := r.bindFirst(
				turnRuntimeKey(session.ID, turn.ID),
				address,
				replayEntityBinding{
					SessionID: session.ID,
					TurnID:    turn.ID,
					EntityID:  turn.ID,
				},
			); !ok {
				return fmt.Errorf("bind initial Turn %q", turn.ID)
			}
		}
		for messageIndex, message := range session.Messages {
			messagePath := fmt.Sprintf(
				"%s/messages/%d",
				sessionPath,
				messageIndex,
			)
			binding := replayEntityBinding{
				SessionID: session.ID,
				TurnID:    message.TurnID,
				EntityID:  message.ID,
				MessageID: message.ID,
			}
			if _, ok := r.bindFirst(
				messageRuntimeKey(session.ID, message.ID),
				initialStateAddress(replay.EntityKindMessage, messagePath),
				binding,
			); !ok {
				return fmt.Errorf("bind initial Message %q", message.ID)
			}
			callID, _ := message.Payload["callId"].(string)
			if strings.TrimSpace(callID) != "" {
				callBinding := binding
				callBinding.EntityID = strings.TrimSpace(callID)
				if _, ok := r.bindFirst(
					toolCallRuntimeKey(
						session.ID,
						message.TurnID,
						callID,
					),
					initialStateAddress(
						replay.EntityKindToolCall,
						messagePath,
					),
					callBinding,
				); !ok {
					return fmt.Errorf(
						"bind initial Tool Call %q",
						callID,
					)
				}
			}
			content, _ := message.Payload["content"].([]any)
			var attachmentIndex uint64
			for contentIndex, item := range content {
				block, _ := item.(map[string]any)
				attachmentID, _ := block["attachmentId"].(string)
				if strings.TrimSpace(attachmentID) == "" {
					continue
				}
				attachmentIndex++
				attachmentBinding := binding
				attachmentBinding.EntityID = attachmentID
				attachmentBinding.AttachmentIndex =
					attachmentIndex
				if _, ok := r.bindFirst(
					attachmentRuntimeKey(
						session.ID,
						message.ID,
						attachmentIndex,
					),
					initialStateAddress(
						replay.EntityKindAttachment,
						fmt.Sprintf(
							"%s/payload/content/%d",
							messagePath,
							contentIndex,
						),
					),
					attachmentBinding,
				); !ok {
					return fmt.Errorf(
						"bind initial Attachment %q",
						attachmentID,
					)
				}
			}
		}
		for interactionIndex, interaction := range session.Interactions {
			address := initialStateAddress(
				replay.EntityKindInteraction,
				fmt.Sprintf(
					"%s/interactions/%d",
					sessionPath,
					interactionIndex,
				),
			)
			if _, ok := r.bindFirst(
				interactionRuntimeKey(
					session.ID,
					interaction.TurnID,
					interaction.Kind,
					interaction.RequestID,
				),
				address,
				replayEntityBinding{
					SessionID: session.ID,
					TurnID:    interaction.TurnID,
					EntityID:  interaction.RequestID,
				},
			); !ok {
				return fmt.Errorf(
					"bind initial Interaction %q",
					interaction.RequestID,
				)
			}
		}
		if session.Goal != nil {
			if _, ok := r.bindFirst(
				goalRuntimeKey(session.ID),
				initialStateAddress(
					replay.EntityKindGoal,
					sessionPath+"/goal",
				),
				replayEntityBinding{
					SessionID: session.ID,
					EntityID:  session.ID,
				},
			); !ok {
				return fmt.Errorf("bind initial Goal for %q", session.ID)
			}
		}
	}
	return nil
}

func (r *replayEntityRegistry) providerAddresses(
	position replay.ProviderObservationPosition,
	event replay.ProviderObservationEvent,
) ([]replay.EntityAddress, bool) {
	return r.providerAddressesForPlan(position, event, replay.CheckpointPlan{})
}

// providerAddressesForPlan binds portable entity addresses for a Provider
// observation. Turn addresses use the plan's birth observation (started /
// subject origin) when available so completed-first replay still fingerprints
// against the same Address recorded at started.
func (r *replayEntityRegistry) providerAddressesForPlan(
	position replay.ProviderObservationPosition,
	event replay.ProviderObservationEvent,
	plan replay.CheckpointPlan,
) ([]replay.EntityAddress, bool) {
	sessionID := strings.TrimSpace(event.AgentSessionID)
	if sessionID == "" {
		sessionID = r.rootSessionID
	}
	if sessionID == "" {
		return nil, false
	}
	if strings.TrimSpace(event.SessionKind) != "child" &&
		strings.TrimSpace(event.ParentAgentSessionID) == "" {
		if r.rootSessionID == "" {
			r.rootSessionID = sessionID
		}
		if _, ok := r.bindFirst(
			sessionRuntimeKey(sessionID),
			recordingRootAddress(),
			replayEntityBinding{
				SessionID: sessionID,
				EntityID:  sessionID,
			},
		); !ok {
			return nil, false
		}
	}
	switch event.Type {
	case "session.started", "session.updated",
		"session.completed", "session.failed":
		if strings.TrimSpace(event.SessionKind) != "child" &&
			strings.TrimSpace(event.ParentAgentSessionID) == "" {
			return nil, false
		}
		address, ok := r.bindFirst(
			sessionRuntimeKey(sessionID),
			providerAddress(replay.EntityKindSession, position, ""),
			replayEntityBinding{
				SessionID: sessionID,
				EntityID:  sessionID,
			},
		)
		return []replay.EntityAddress{address}, ok
	case "turn.started", "turn.updated", "turn.completed",
		"turn.failed", "turn.canceled",
		"root_provider_turn.started", "root_provider_turn.completed",
		"plan.proposed", "compaction.updated":
		turnID := strings.TrimSpace(event.TurnID)
		if turnID == "" {
			return nil, false
		}
		birth := turnBirthPositionFromPlan(plan, position, event.Type)
		address, ok := r.bindFirst(
			turnRuntimeKey(sessionID, turnID),
			providerAddress(replay.EntityKindTurn, birth, ""),
			replayEntityBinding{
				SessionID: sessionID,
				TurnID:    turnID,
				EntityID:  turnID,
			},
		)
		return []replay.EntityAddress{address}, ok
	case "call.started", "call.completed", "call.failed":
		turnID := strings.TrimSpace(event.TurnID)
		callID := strings.TrimSpace(event.CallID)
		if turnID == "" || callID == "" {
			return nil, false
		}
		address, ok := r.bindFirst(
			toolCallRuntimeKey(sessionID, turnID, callID),
			providerAddress(replay.EntityKindToolCall, position, ""),
			replayEntityBinding{
				SessionID: sessionID,
				TurnID:    turnID,
				EntityID:  callID,
			},
		)
		return []replay.EntityAddress{address}, ok
	case "interaction.requested", "interaction.superseded":
		turnID := strings.TrimSpace(event.TurnID)
		requestID := strings.TrimSpace(event.InteractionID)
		kind := firstNonEmpty(event.InteractionKind, "approval")
		if turnID == "" || requestID == "" {
			return nil, false
		}
		address, ok := r.bindFirst(
			interactionRuntimeKey(
				sessionID,
				turnID,
				kind,
				requestID,
			),
			providerAddress(replay.EntityKindInteraction, position, ""),
			replayEntityBinding{
				SessionID: sessionID,
				TurnID:    turnID,
				EntityID:  requestID,
			},
		)
		return []replay.EntityAddress{address}, ok
	case "attachment.materialized":
		turnID := strings.TrimSpace(event.TurnID)
		messageID := strings.TrimSpace(event.MessageID)
		if turnID == "" || messageID == "" ||
			event.AttachmentCount == 0 {
			return nil, false
		}
		_, _ = r.bindFirst(
			messageRuntimeKey(sessionID, messageID),
			providerAddress(
				replay.EntityKindMessage,
				position,
				"message",
			),
			replayEntityBinding{
				SessionID: sessionID,
				TurnID:    turnID,
				EntityID:  messageID,
				MessageID: messageID,
			},
		)
		addresses := make(
			[]replay.EntityAddress,
			0,
			event.AttachmentCount,
		)
		for index := uint64(1); index <= event.AttachmentCount; index++ {
			address, ok := r.bindFirst(
				attachmentRuntimeKey(sessionID, messageID, index),
				providerAddress(
					replay.EntityKindAttachment,
					position,
					strconv.FormatUint(index, 10),
				),
				replayEntityBinding{
					SessionID:       sessionID,
					TurnID:          turnID,
					EntityID:        messageID,
					MessageID:       messageID,
					AttachmentIndex: index,
				},
			)
			if !ok {
				return nil, false
			}
			addresses = append(addresses, address)
		}
		return addresses, true
	default:
		return nil, false
	}
}

func runtimeKey(parts ...string) string {
	var result strings.Builder
	for _, part := range parts {
		part = strings.TrimSpace(part)
		result.WriteString(strconv.Itoa(len(part)))
		result.WriteByte(':')
		result.WriteString(part)
	}
	return result.String()
}

// turnBirthPositionFromPlan picks the portable Address origin for a turn
// observation. Fingerprints embed that Address; using the current event
// position for completed-first replay would diverge from the Address recorded
// when started bound first. Prefer:
//  1. started/turn.started events → current position
//  2. matching checkpoint subject origin at this event position
//  3. latest started trigger on the same connection before this event
//  4. current position (degraded)
func turnBirthPositionFromPlan(
	plan replay.CheckpointPlan,
	eventPosition replay.ProviderObservationPosition,
	eventType string,
) replay.ProviderObservationPosition {
	switch eventType {
	case "turn.started", "root_provider_turn.started":
		return eventPosition
	}
	for _, checkpoint := range plan.Checkpoints {
		trigger := checkpoint.Trigger
		if trigger.Source !=
			replay.CheckpointTriggerProviderObservation ||
			trigger.Position == nil ||
			*trigger.Position != eventPosition {
			continue
		}
		for _, subject := range checkpoint.Subjects {
			if subject.Kind != replay.EntityKindTurn ||
				subject.Origin.Source !=
					replay.EntityOriginProviderObservation ||
				subject.Origin.ProviderObservation == nil {
				continue
			}
			return *subject.Origin.ProviderObservation
		}
	}
	var best *replay.ProviderObservationPosition
	for _, checkpoint := range plan.Checkpoints {
		trigger := checkpoint.Trigger
		if trigger.Source !=
			replay.CheckpointTriggerProviderObservation ||
			trigger.Position == nil {
			continue
		}
		if trigger.Type != "turn.started" &&
			trigger.Type != "root_provider_turn.started" {
			continue
		}
		started := *trigger.Position
		if started.ConnectionID != eventPosition.ConnectionID {
			continue
		}
		if !providerObservationPositionBeforeOrEqual(
			started,
			eventPosition,
		) {
			continue
		}
		if best == nil ||
			providerObservationPositionBeforeOrEqual(*best, started) {
			copy := started
			best = &copy
		}
	}
	if best != nil {
		return *best
	}
	return eventPosition
}

func providerObservationPositionBeforeOrEqual(
	left, right replay.ProviderObservationPosition,
) bool {
	if left.ConnectionID != right.ConnectionID {
		return false
	}
	if left.ChunkSeq != right.ChunkSeq {
		return left.ChunkSeq < right.ChunkSeq
	}
	if left.UnitIndex != right.UnitIndex {
		return left.UnitIndex < right.UnitIndex
	}
	return left.EventIndex <= right.EventIndex
}

func sessionRuntimeKey(sessionID string) string {
	return runtimeKey("session", sessionID)
}

func turnRuntimeKey(sessionID, turnID string) string {
	return runtimeKey("turn", sessionID, turnID)
}

func messageRuntimeKey(sessionID, messageID string) string {
	return runtimeKey("message", sessionID, messageID)
}

func toolCallRuntimeKey(sessionID, turnID, callID string) string {
	return runtimeKey("tool-call", sessionID, turnID, callID)
}

func interactionRuntimeKey(
	sessionID, turnID, kind, requestID string,
) string {
	return runtimeKey(
		"interaction",
		sessionID,
		turnID,
		kind,
		requestID,
	)
}

func goalRuntimeKey(sessionID string) string {
	return runtimeKey("goal", sessionID)
}

func attachmentRuntimeKey(
	sessionID, messageID string,
	index uint64,
) string {
	return runtimeKey(
		"attachment",
		sessionID,
		messageID,
		strconv.FormatUint(index, 10),
	)
}
