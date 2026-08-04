package sessionreplay

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
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
	byRuntime     map[string]EntityAddress
	byAddress     map[string]replayEntityBinding
}

func newReplayEntityRegistry(rootSessionID string) replayEntityRegistry {
	r := replayEntityRegistry{
		rootSessionID: strings.TrimSpace(rootSessionID),
		byRuntime:     make(map[string]EntityAddress),
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

func recordingRootAddress() EntityAddress {
	return EntityAddress{
		Kind: EntityKindSession,
		Origin: EntityOrigin{
			Source: EntityOriginRecordingRoot,
		},
	}
}

func initialStateAddress(
	kind EntityKind,
	path string,
) EntityAddress {
	return EntityAddress{
		Kind: kind,
		Origin: EntityOrigin{
			Source:           EntityOriginInitialState,
			InitialStatePath: path,
		},
	}
}

func replayActivityAddress(
	kind EntityKind,
	sequence uint64,
	discriminator string,
) EntityAddress {
	return EntityAddress{
		Kind: kind,
		Origin: EntityOrigin{
			Source:                EntityOriginActivityEvent,
			ActivityEventSequence: sequence,
		},
		Discriminator: discriminator,
	}
}

func replayProviderAddress(
	kind EntityKind,
	position ProviderObservationPosition,
	discriminator string,
) EntityAddress {
	return EntityAddress{
		Kind: kind,
		Origin: EntityOrigin{
			Source:              EntityOriginProviderObservation,
			ProviderObservation: &position,
		},
		Discriminator: discriminator,
	}
}

func (r *replayEntityRegistry) bind(
	runtimeKey string,
	address EntityAddress,
	binding replayEntityBinding,
) (EntityAddress, bool) {
	runtimeKey = strings.TrimSpace(runtimeKey)
	if runtimeKey == "" || ValidateEntityAddress(address) != nil {
		return EntityAddress{}, false
	}
	addressKey, err := EntityAddressKey(address)
	if err != nil {
		return EntityAddress{}, false
	}
	if existing, ok := r.byRuntime[runtimeKey]; ok {
		return existing, EntityAddressesEqual(existing, address)
	}
	if existing, ok := r.byAddress[addressKey]; ok &&
		existing != binding {
		return EntityAddress{}, false
	}
	r.byRuntime[runtimeKey] = address
	r.byAddress[addressKey] = binding
	return address, true
}

func (r *replayEntityRegistry) bindFirst(
	runtimeKey string,
	address EntityAddress,
	binding replayEntityBinding,
) (EntityAddress, bool) {
	if existing, ok := r.byRuntime[strings.TrimSpace(runtimeKey)]; ok {
		existingBinding, found := r.binding(existing)
		return existing, found && existingBinding == binding
	}
	return r.bind(runtimeKey, address, binding)
}

func entityParentDiscriminator(address EntityAddress) string {
	key, err := EntityAddressKey(address)
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
	address EntityAddress,
) bool {
	if _, ok := r.binding(address); ok {
		return true
	}
	if address.Origin.Source != EntityOriginActivityEvent {
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
	case EntityKindGoal:
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
	address EntityAddress,
) (replayEntityBinding, bool) {
	key, err := EntityAddressKey(address)
	if err != nil {
		return replayEntityBinding{}, false
	}
	binding, ok := r.byAddress[key]
	return binding, ok
}

func (r replayEntityRegistry) sessionAddress(
	sessionID string,
) (EntityAddress, bool) {
	sessionID = strings.TrimSpace(sessionID)
	if sessionID == "" {
		sessionID = r.rootSessionID
	}
	address, ok := r.byRuntime[sessionRuntimeKey(sessionID)]
	return address, ok
}

func (r replayEntityRegistry) turnAddress(
	sessionID, turnID string,
) (EntityAddress, bool) {
	address, ok := r.byRuntime[turnRuntimeKey(sessionID, turnID)]
	return address, ok
}

func (r replayEntityRegistry) interactionAddress(
	sessionID, turnID, kind, requestID string,
) (EntityAddress, bool) {
	key := interactionRuntimeKey(sessionID, turnID, kind, requestID)
	address, ok := r.byRuntime[key]
	if ok {
		return address, true
	}
	var matched EntityAddress
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
	var state TuttiReplayState
	if err := json.Unmarshal(raw, &state); err != nil {
		return fmt.Errorf("decode replay initial state identities: %w", err)
	}
	return r.seedState(state)
}

func (r *replayEntityRegistry) seedState(
	state TuttiReplayState,
) error {
	for sessionIndex, session := range state.Agent.Sessions {
		sessionPath := fmt.Sprintf("/agent/sessions/%d", sessionIndex)
		sessionAddress := initialStateAddress(
			EntityKindSession,
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
				EntityKindTurn,
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
				initialStateAddress(EntityKindMessage, messagePath),
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
						EntityKindToolCall,
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
						EntityKindAttachment,
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
				EntityKindInteraction,
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
					EntityKindGoal,
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
	position ProviderObservationPosition,
	event ProviderObservationEvent,
) ([]EntityAddress, bool) {
	return r.providerAddressesForPlan(position, event, CheckpointPlan{})
}

// providerAddressesForPlan binds portable entity addresses for a Provider
// observation. Turn addresses use the plan's birth observation (started /
// subject origin) when available so completed-first replay still fingerprints
// against the same Address recorded at started.
func (r *replayEntityRegistry) providerAddressesForPlan(
	position ProviderObservationPosition,
	event ProviderObservationEvent,
	plan CheckpointPlan,
) ([]EntityAddress, bool) {
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
			replayProviderAddress(EntityKindSession, position, ""),
			replayEntityBinding{
				SessionID: sessionID,
				EntityID:  sessionID,
			},
		)
		return []EntityAddress{address}, ok
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
			replayProviderAddress(EntityKindTurn, birth, ""),
			replayEntityBinding{
				SessionID: sessionID,
				TurnID:    turnID,
				EntityID:  turnID,
			},
		)
		return []EntityAddress{address}, ok
	case "call.started", "call.completed", "call.failed":
		turnID := strings.TrimSpace(event.TurnID)
		callID := strings.TrimSpace(event.CallID)
		if turnID == "" || callID == "" {
			return nil, false
		}
		address, ok := r.bindFirst(
			toolCallRuntimeKey(sessionID, turnID, callID),
			replayProviderAddress(EntityKindToolCall, position, ""),
			replayEntityBinding{
				SessionID: sessionID,
				TurnID:    turnID,
				EntityID:  callID,
			},
		)
		return []EntityAddress{address}, ok
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
			replayProviderAddress(EntityKindInteraction, position, ""),
			replayEntityBinding{
				SessionID: sessionID,
				TurnID:    turnID,
				EntityID:  requestID,
			},
		)
		return []EntityAddress{address}, ok
	case "attachment.materialized":
		turnID := strings.TrimSpace(event.TurnID)
		messageID := strings.TrimSpace(event.MessageID)
		if turnID == "" || messageID == "" ||
			event.AttachmentCount == 0 {
			return nil, false
		}
		_, _ = r.bindFirst(
			messageRuntimeKey(sessionID, messageID),
			replayProviderAddress(
				EntityKindMessage,
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
			[]EntityAddress,
			0,
			event.AttachmentCount,
		)
		for index := uint64(1); index <= event.AttachmentCount; index++ {
			address, ok := r.bindFirst(
				attachmentRuntimeKey(sessionID, messageID, index),
				replayProviderAddress(
					EntityKindAttachment,
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
	plan CheckpointPlan,
	eventPosition ProviderObservationPosition,
	eventType string,
) ProviderObservationPosition {
	switch eventType {
	case "turn.started", "root_provider_turn.started":
		return eventPosition
	}
	for _, checkpoint := range plan.Checkpoints {
		trigger := checkpoint.Trigger
		if trigger.Source !=
			CheckpointTriggerProviderObservation ||
			trigger.Position == nil ||
			*trigger.Position != eventPosition {
			continue
		}
		for _, subject := range checkpoint.Subjects {
			if subject.Kind != EntityKindTurn ||
				subject.Origin.Source !=
					EntityOriginProviderObservation ||
				subject.Origin.ProviderObservation == nil {
				continue
			}
			return *subject.Origin.ProviderObservation
		}
	}
	var best *ProviderObservationPosition
	for _, checkpoint := range plan.Checkpoints {
		trigger := checkpoint.Trigger
		if trigger.Source !=
			CheckpointTriggerProviderObservation ||
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
	left, right ProviderObservationPosition,
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
