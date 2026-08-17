package storesqlite

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
)

type sessionForkInteractionRef struct {
	TurnID    string
	RequestID string
}

type sessionForkCanonicalIdentityMap struct {
	SourceSessionID string
	TargetSessionID string
	TurnIDs         map[string]string
	MessageIDs      map[string]string
	InteractionIDs  map[sessionForkInteractionRef]string
	AttachmentIDs   map[string]string
}

func buildSessionForkCanonicalIdentityMap(
	operation SessionForkOperation,
	snapshot sessionForkSnapshot,
) (sessionForkCanonicalIdentityMap, error) {
	identityMap := sessionForkCanonicalIdentityMap{
		SourceSessionID: strings.TrimSpace(operation.SourceAgentSessionID),
		TargetSessionID: strings.TrimSpace(operation.TargetAgentSessionID),
		TurnIDs:         make(map[string]string, len(snapshot.Turns)),
		MessageIDs:      make(map[string]string, len(snapshot.Messages)),
		InteractionIDs:  make(map[sessionForkInteractionRef]string, len(snapshot.Interactions)),
		AttachmentIDs:   make(map[string]string),
	}
	if strings.TrimSpace(operation.WorkspaceID) == "" ||
		strings.TrimSpace(operation.OperationID) == "" ||
		identityMap.SourceSessionID == "" ||
		identityMap.TargetSessionID == "" ||
		identityMap.SourceSessionID == identityMap.TargetSessionID {
		return sessionForkCanonicalIdentityMap{}, errors.New(
			"session fork canonical identity requires distinct source and target sessions",
		)
	}

	targetTurnIDs := make(map[string]string, len(snapshot.Turns))
	for _, item := range snapshot.Turns {
		sourceID := strings.TrimSpace(item.Turn.TurnID)
		if sourceID == "" {
			return sessionForkCanonicalIdentityMap{}, errors.New(
				"session fork snapshot contains an empty turn identity",
			)
		}
		if _, exists := identityMap.TurnIDs[sourceID]; exists {
			return sessionForkCanonicalIdentityMap{}, fmt.Errorf(
				"session fork snapshot contains duplicate turn identity %q",
				sourceID,
			)
		}
		targetID := deterministicSessionForkCanonicalID(operation, "turn", sourceID)
		if prior, exists := targetTurnIDs[targetID]; exists {
			return sessionForkCanonicalIdentityMap{}, fmt.Errorf(
				"session fork turn identity collision between %q and %q",
				prior,
				sourceID,
			)
		}
		identityMap.TurnIDs[sourceID] = targetID
		targetTurnIDs[targetID] = sourceID
	}

	targetMessageIDs := make(map[string]string, len(snapshot.Messages))
	for _, message := range snapshot.Messages {
		collectSessionForkAttachmentIDs(message.Payload, identityMap.AttachmentIDs)
		sourceID := strings.TrimSpace(message.MessageID)
		if sourceID == "" {
			return sessionForkCanonicalIdentityMap{}, errors.New(
				"session fork snapshot contains an empty message identity",
			)
		}
		if _, exists := identityMap.MessageIDs[sourceID]; exists {
			return sessionForkCanonicalIdentityMap{}, fmt.Errorf(
				"session fork snapshot contains duplicate message identity %q",
				sourceID,
			)
		}
		if sourceTurnID := strings.TrimSpace(message.TurnID); sourceTurnID != "" {
			if _, exists := identityMap.TurnIDs[sourceTurnID]; !exists {
				return sessionForkCanonicalIdentityMap{}, fmt.Errorf(
					"session fork message %q references unmapped turn %q",
					sourceID,
					sourceTurnID,
				)
			}
		}
		targetID := deterministicSessionForkCanonicalID(operation, "message", sourceID)
		if prior, exists := targetMessageIDs[targetID]; exists {
			return sessionForkCanonicalIdentityMap{}, fmt.Errorf(
				"session fork message identity collision between %q and %q",
				prior,
				sourceID,
			)
		}
		identityMap.MessageIDs[sourceID] = targetID
		targetMessageIDs[targetID] = sourceID
	}
	for sourceID := range identityMap.AttachmentIDs {
		identityMap.AttachmentIDs[sourceID] = deterministicSessionForkCanonicalID(
			operation,
			"attachment",
			sourceID,
		)
	}

	targetInteractionIDs := make(map[sessionForkInteractionRef]sessionForkInteractionRef, len(snapshot.Interactions))
	for _, interaction := range snapshot.Interactions {
		sourceRef := sessionForkInteractionRef{
			TurnID:    strings.TrimSpace(interaction.TurnID),
			RequestID: strings.TrimSpace(interaction.RequestID),
		}
		if sourceRef.TurnID == "" || sourceRef.RequestID == "" {
			return sessionForkCanonicalIdentityMap{}, errors.New(
				"session fork snapshot contains an incomplete interaction identity",
			)
		}
		targetTurnID, exists := identityMap.TurnIDs[sourceRef.TurnID]
		if !exists {
			return sessionForkCanonicalIdentityMap{}, fmt.Errorf(
				"session fork interaction %q references unmapped turn %q",
				sourceRef.RequestID,
				sourceRef.TurnID,
			)
		}
		if _, exists := identityMap.InteractionIDs[sourceRef]; exists {
			return sessionForkCanonicalIdentityMap{}, fmt.Errorf(
				"session fork snapshot contains duplicate interaction identity %q in turn %q",
				sourceRef.RequestID,
				sourceRef.TurnID,
			)
		}
		targetRequestID := deterministicSessionForkCanonicalID(
			operation,
			"interaction",
			sourceRef.TurnID+"\x00"+sourceRef.RequestID,
		)
		targetRef := sessionForkInteractionRef{
			TurnID:    targetTurnID,
			RequestID: targetRequestID,
		}
		if prior, exists := targetInteractionIDs[targetRef]; exists {
			return sessionForkCanonicalIdentityMap{}, fmt.Errorf(
				"session fork interaction identity collision between %#v and %#v",
				prior,
				sourceRef,
			)
		}
		identityMap.InteractionIDs[sourceRef] = targetRequestID
		targetInteractionIDs[targetRef] = sourceRef
	}

	for _, item := range snapshot.Turns {
		finalMessageID := strings.TrimSpace(item.Turn.FinalAssistantMessageID)
		if finalMessageID == "" {
			continue
		}
		if _, exists := identityMap.MessageIDs[finalMessageID]; !exists {
			return sessionForkCanonicalIdentityMap{}, fmt.Errorf(
				"session fork turn %q references unmapped final assistant message %q",
				item.Turn.TurnID,
				finalMessageID,
			)
		}
	}
	return identityMap, nil
}

func deterministicSessionForkCanonicalID(
	operation SessionForkOperation,
	entityKind string,
	sourceIdentity string,
) string {
	sum := sha256.Sum256([]byte(strings.Join([]string{
		"tutti-session-fork-canonical-id-v1",
		strings.TrimSpace(operation.WorkspaceID),
		strings.TrimSpace(operation.OperationID),
		strings.TrimSpace(operation.SourceAgentSessionID),
		strings.TrimSpace(operation.TargetAgentSessionID),
		strings.TrimSpace(entityKind),
		sourceIdentity,
	}, "\x00")))
	return "fork-" + strings.TrimSpace(entityKind) + "-" + hex.EncodeToString(sum[:])
}

func remapSessionForkTurn(
	turn Turn,
	identityMap sessionForkCanonicalIdentityMap,
) (Turn, error) {
	sourceTurnID := strings.TrimSpace(turn.TurnID)
	targetTurnID, exists := identityMap.TurnIDs[sourceTurnID]
	if !exists {
		return Turn{}, fmt.Errorf("session fork turn %q has no canonical mapping", sourceTurnID)
	}
	turn.AgentSessionID = identityMap.TargetSessionID
	turn.TurnID = targetTurnID
	if sourceAnchorTurnID := strings.TrimSpace(turn.IdentityAnchorTurnID); sourceAnchorTurnID != "" {
		targetAnchorTurnID, exists := identityMap.TurnIDs[sourceAnchorTurnID]
		if !exists {
			return Turn{}, fmt.Errorf(
				"session fork turn identity anchor %q has no canonical mapping",
				sourceAnchorTurnID,
			)
		}
		turn.IdentityAnchorTurnID = targetAnchorTurnID
	}
	if sourceMessageID := strings.TrimSpace(turn.FinalAssistantMessageID); sourceMessageID != "" {
		targetMessageID, exists := identityMap.MessageIDs[sourceMessageID]
		if !exists {
			return Turn{}, fmt.Errorf(
				"session fork final assistant message %q has no canonical mapping",
				sourceMessageID,
			)
		}
		turn.FinalAssistantMessageID = targetMessageID
	}
	return turn, nil
}

func remapSessionForkMessage(
	message Message,
	identityMap sessionForkCanonicalIdentityMap,
) (Message, error) {
	sourceMessageID := strings.TrimSpace(message.MessageID)
	targetMessageID, exists := identityMap.MessageIDs[sourceMessageID]
	if !exists {
		return Message{}, fmt.Errorf(
			"session fork message %q has no canonical mapping",
			sourceMessageID,
		)
	}
	sourceTurnID := strings.TrimSpace(message.TurnID)
	targetTurnID := ""
	if sourceTurnID != "" {
		targetTurnID, exists = identityMap.TurnIDs[sourceTurnID]
		if !exists {
			return Message{}, fmt.Errorf(
				"session fork message %q turn %q has no canonical mapping",
				sourceMessageID,
				sourceTurnID,
			)
		}
	}
	payload, err := rewriteSessionForkMessagePayload(message, sourceTurnID, identityMap)
	if err != nil {
		return Message{}, fmt.Errorf(
			"rewrite session fork message %q payload: %w",
			sourceMessageID,
			err,
		)
	}
	message.AgentSessionID = identityMap.TargetSessionID
	message.MessageID = targetMessageID
	message.TurnID = targetTurnID
	message.Payload = payload
	return message, nil
}

func remapSessionForkInteraction(
	interaction Interaction,
	identityMap sessionForkCanonicalIdentityMap,
) (Interaction, error) {
	sourceRef := sessionForkInteractionRef{
		TurnID:    strings.TrimSpace(interaction.TurnID),
		RequestID: strings.TrimSpace(interaction.RequestID),
	}
	targetTurnID, turnExists := identityMap.TurnIDs[sourceRef.TurnID]
	targetRequestID, requestExists := identityMap.InteractionIDs[sourceRef]
	if !turnExists || !requestExists {
		return Interaction{}, fmt.Errorf(
			"session fork interaction %#v has no complete canonical mapping",
			sourceRef,
		)
	}
	input, output, metadata, err := rewriteSessionForkInteractionPayload(
		interaction,
		sourceRef.TurnID,
		identityMap,
	)
	if err != nil {
		return Interaction{}, fmt.Errorf("rewrite session fork interaction payload: %w", err)
	}
	interaction.AgentSessionID = identityMap.TargetSessionID
	interaction.TurnID = targetTurnID
	interaction.RequestID = targetRequestID
	interaction.Input = input
	interaction.Output = output
	interaction.Metadata = metadata
	return interaction, nil
}

type sessionForkCanonicalRefKind string

const (
	sessionForkCanonicalRefTurn        sessionForkCanonicalRefKind = "turn"
	sessionForkCanonicalRefMessage     sessionForkCanonicalRefKind = "message"
	sessionForkCanonicalRefInteraction sessionForkCanonicalRefKind = "interaction"
)

type sessionForkCanonicalRefPath struct {
	Path []string
	Kind sessionForkCanonicalRefKind
}

// rewriteSessionForkMessagePayload uses a closed schema/path catalog. Message
// bodies are intentionally opaque: content, input, output, error, Markdown,
// code, and arbitrary user/tool JSON are never recursively inspected.
func rewriteSessionForkMessagePayload(
	message Message,
	sourceTurnID string,
	identityMap sessionForkCanonicalIdentityMap,
) (map[string]any, error) {
	payload := message.Payload
	if payload == nil {
		return nil, nil
	}
	paths := make([]sessionForkCanonicalRefPath, 0, 3)
	switch strings.ToLower(strings.TrimSpace(message.Kind)) {
	case "session_audit":
		// goal-control audits use auditId as the canonical Message identity.
		// Their optional messageId is submit provenance and is not necessarily
		// a canonical workspace_agent_messages identity.
		paths = append(paths, sessionForkCanonicalRefPath{
			Path: []string{"auditId"},
			Kind: sessionForkCanonicalRefMessage,
		})
	case "tool_call":
		if sessionForkInteractiveCallPayload(payload) {
			paths = append(paths,
				sessionForkCanonicalRefPath{
					Path: []string{"requestId"},
					Kind: sessionForkCanonicalRefInteraction,
				},
				sessionForkCanonicalRefPath{
					Path: []string{"output", "requestId"},
					Kind: sessionForkCanonicalRefInteraction,
				},
				sessionForkCanonicalRefPath{
					Path: []string{"error", "requestId"},
					Kind: sessionForkCanonicalRefInteraction,
				},
			)
		}
	}
	if strings.EqualFold(strings.TrimSpace(payloadString(payload, "kind")), "agent_system_notice") {
		paths = append(paths,
			sessionForkCanonicalRefPath{
				Path: []string{"planTurnId"},
				Kind: sessionForkCanonicalRefTurn,
			},
			sessionForkCanonicalRefPath{
				Path: []string{"confirmedTurnId"},
				Kind: sessionForkCanonicalRefTurn,
			},
		)
	}
	rewritten, err := rewriteSessionForkCanonicalPaths(
		payload,
		sourceTurnID,
		identityMap,
		paths,
	)
	if err != nil {
		return nil, err
	}
	return rewriteSessionForkAttachmentIDs(rewritten, identityMap.AttachmentIDs), nil
}

func collectSessionForkAttachmentIDs(
	value any,
	ids map[string]string,
) {
	switch typed := value.(type) {
	case map[string]any:
		if attachmentID, ok := typed["attachmentId"].(string); ok {
			if attachmentID = strings.TrimSpace(attachmentID); attachmentID != "" {
				ids[attachmentID] = ""
			}
		}
		for _, nested := range typed {
			collectSessionForkAttachmentIDs(nested, ids)
		}
	case []any:
		for _, nested := range typed {
			collectSessionForkAttachmentIDs(nested, ids)
		}
	}
}

func rewriteSessionForkAttachmentIDs(
	value any,
	ids map[string]string,
) map[string]any {
	payload, _ := cloneSessionForkCanonicalValue(value).(map[string]any)
	var rewrite func(any)
	rewrite = func(candidate any) {
		switch typed := candidate.(type) {
		case map[string]any:
			if sourceID, ok := typed["attachmentId"].(string); ok {
				if targetID := ids[strings.TrimSpace(sourceID)]; targetID != "" {
					typed["attachmentId"] = targetID
				}
			}
			for _, nested := range typed {
				rewrite(nested)
			}
		case []any:
			for _, nested := range typed {
				rewrite(nested)
			}
		}
	}
	rewrite(payload)
	return payload
}

func sessionForkInteractiveCallPayload(payload map[string]any) bool {
	switch strings.ToLower(strings.TrimSpace(payloadString(payload, "callType"))) {
	case "approval", "interactive":
		return true
	default:
		return false
	}
}

// rewriteSessionForkInteractionPayload applies only the paths owned by the
// closed Interaction kind. Provider prompt metadata and arbitrary answer/tool
// payloads remain opaque.
func rewriteSessionForkInteractionPayload(
	interaction Interaction,
	sourceTurnID string,
	identityMap sessionForkCanonicalIdentityMap,
) (map[string]any, map[string]any, map[string]any, error) {
	var inputPaths []sessionForkCanonicalRefPath
	switch strings.ToLower(strings.TrimSpace(interaction.Kind)) {
	case InteractionKindApproval:
		inputPaths = []sessionForkCanonicalRefPath{{
			Path: []string{"requestId"},
			Kind: sessionForkCanonicalRefInteraction,
		}}
	case InteractionKindQuestion, InteractionKindPlan:
	default:
		return nil, nil, nil, fmt.Errorf(
			"session fork interaction kind %q has no canonical payload schema",
			interaction.Kind,
		)
	}
	input, err := rewriteSessionForkCanonicalPaths(
		interaction.Input,
		sourceTurnID,
		identityMap,
		inputPaths,
	)
	if err != nil {
		return nil, nil, nil, fmt.Errorf("input: %w", err)
	}
	output, err := rewriteSessionForkCanonicalPaths(
		interaction.Output,
		sourceTurnID,
		identityMap,
		[]sessionForkCanonicalRefPath{{
			Path: []string{"requestId"},
			Kind: sessionForkCanonicalRefInteraction,
		}},
	)
	if err != nil {
		return nil, nil, nil, fmt.Errorf("output: %w", err)
	}
	metadata, err := rewriteSessionForkCanonicalPaths(
		interaction.Metadata,
		sourceTurnID,
		identityMap,
		nil,
	)
	if err != nil {
		return nil, nil, nil, fmt.Errorf("metadata: %w", err)
	}
	return input, output, metadata, nil
}

func rewriteSessionForkCanonicalPaths(
	value map[string]any,
	sourceTurnID string,
	identityMap sessionForkCanonicalIdentityMap,
	paths []sessionForkCanonicalRefPath,
) (map[string]any, error) {
	if value == nil {
		return nil, nil
	}
	result, ok := cloneSessionForkCanonicalValue(value).(map[string]any)
	if !ok {
		return nil, errors.New("session fork canonical payload root is not an object")
	}
	for _, refPath := range paths {
		if err := rewriteSessionForkCanonicalPath(
			result,
			strings.TrimSpace(sourceTurnID),
			identityMap,
			refPath,
		); err != nil {
			return nil, err
		}
	}
	return result, nil
}

func cloneSessionForkCanonicalValue(value any) any {
	switch typed := value.(type) {
	case map[string]any:
		result := make(map[string]any, len(typed))
		for key, nested := range typed {
			result[key] = cloneSessionForkCanonicalValue(nested)
		}
		return result
	case []any:
		result := make([]any, len(typed))
		for index, nested := range typed {
			result[index] = cloneSessionForkCanonicalValue(nested)
		}
		return result
	default:
		return typed
	}
}

func rewriteSessionForkCanonicalPath(
	payload map[string]any,
	sourceTurnID string,
	identityMap sessionForkCanonicalIdentityMap,
	refPath sessionForkCanonicalRefPath,
) error {
	if len(refPath.Path) == 0 {
		return errors.New("session fork canonical reference path is empty")
	}
	parent := payload
	for index, key := range refPath.Path {
		value, exists := parent[key]
		if !exists {
			return nil
		}
		if index < len(refPath.Path)-1 {
			nested, ok := value.(map[string]any)
			if !ok {
				return fmt.Errorf(
					"session fork canonical reference path %q is not an object",
					strings.Join(refPath.Path[:index+1], "."),
				)
			}
			parent = nested
			continue
		}
		identity, ok := value.(string)
		identity = strings.TrimSpace(identity)
		if !ok || identity == "" {
			return fmt.Errorf(
				"session fork canonical reference %q is not a non-empty string",
				strings.Join(refPath.Path, "."),
			)
		}
		var target string
		var mapped bool
		switch refPath.Kind {
		case sessionForkCanonicalRefTurn:
			target, mapped = identityMap.TurnIDs[identity]
		case sessionForkCanonicalRefMessage:
			target, mapped = identityMap.MessageIDs[identity]
		case sessionForkCanonicalRefInteraction:
			sourceRef := sessionForkInteractionRef{
				TurnID:    sourceTurnID,
				RequestID: identity,
			}
			target, mapped = identityMap.InteractionIDs[sourceRef]
		default:
			return fmt.Errorf(
				"session fork canonical reference %q has unknown kind %q",
				strings.Join(refPath.Path, "."),
				refPath.Kind,
			)
		}
		if !mapped {
			return fmt.Errorf(
				"session fork canonical reference %q=%q has no %s mapping",
				strings.Join(refPath.Path, "."),
				identity,
				refPath.Kind,
			)
		}
		parent[key] = target
	}
	return nil
}
