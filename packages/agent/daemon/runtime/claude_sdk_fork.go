package agentruntime

import (
	"context"
	"errors"
	"strings"
)

const (
	claudeSDKForkDriverKind = "claude-agent-sdk-session-fork"
	// The official SDK forkSession API allocates the provider child identity.
	// Host therefore permits one dispatch and fails closed instead of replaying
	// an unknown result that could create a duplicate provider child.
	claudeSDKForkDriverVersion = "0.3.201/sidecar-v6-official-fork-api"
)

func (a *ClaudeCodeSDKAdapter) ForkCapabilities(
	ctx context.Context,
	source Session,
) (SessionForkCapabilities, error) {
	if a == nil || a.transport == nil {
		return SessionForkCapabilities{}, nil
	}
	event, _, err := a.statelessClaudeSDKForkRequest(
		ctx,
		source,
		claudeSDKSidecarRequest{
			ID:   newID(),
			Type: "inspect_fork_checkpoints",
			Payload: map[string]any{
				"providerSessionId": strings.TrimSpace(source.ProviderSessionID),
				"cwd":               strings.TrimSpace(source.CWD),
			},
		},
	)
	if err != nil {
		return SessionForkCapabilities{}, err
	}
	turnIDs, ok := claudeSDKPayloadStringList(event.Payload, "providerTurnIds")
	if !ok {
		return SessionForkCapabilities{}, errors.New(
			"claude SDK fork inspection returned invalid provider turn identities",
		)
	}
	return SessionForkCapabilities{
		DriverKind:                   claudeSDKForkDriverKind,
		DriverVersion:                claudeSDKForkDriverVersion,
		StateBindingMode:             "provider_owned",
		DeterministicTargetSessionID: false,
		ThroughTurn:                  len(turnIDs) != 0,
		ThroughProviderTurnIDs:       turnIDs,
		ThroughProviderTurnIDsKnown:  true,
	}, nil
}

func (a *ClaudeCodeSDKAdapter) Fork(
	ctx context.Context,
	input SessionForkInput,
) (SessionForkResult, error) {
	result := SessionForkResult{
		ForkedFromProviderSessionID: strings.TrimSpace(input.Source.ProviderSessionID),
		ThroughProviderTurnID:       strings.TrimSpace(input.ProviderTurnID),
		DeliveryDisposition:         SessionForkDeliveryNotStarted,
	}
	if a == nil || a.transport == nil {
		return result, ErrSessionForkUnsupported
	}
	event, sent, err := a.statelessClaudeSDKForkRequest(
		ctx,
		input.Source,
		claudeSDKSidecarRequest{
			ID:   newID(),
			Type: "fork_session",
			Payload: map[string]any{
				"providerSessionId": strings.TrimSpace(input.Source.ProviderSessionID),
				"providerTurnId":    strings.TrimSpace(input.ProviderTurnID),
				"providerTurnIds":   append([]string(nil), input.ProviderTurnIDs...),
				"cwd":               strings.TrimSpace(input.Source.CWD),
				"title":             strings.TrimSpace(input.TargetTitle),
			},
		},
	)
	if err != nil {
		if sent {
			result.DeliveryDisposition = SessionForkDeliveryUnknown
		}
		if eventDisposition := SessionForkDeliveryDisposition(
			payloadString(event.Payload, "deliveryDisposition"),
		); eventDisposition == SessionForkDeliveryNotStarted ||
			eventDisposition == SessionForkDeliveryUnknown {
			result.DeliveryDisposition = eventDisposition
		}
		return result, err
	}
	targetTurnIDs, ok := claudeSDKPayloadStringList(
		event.Payload,
		"targetProviderTurnIds",
	)
	if !ok {
		result.DeliveryDisposition = SessionForkDeliveryUnknown
		return result, errors.New(
			"claude SDK fork returned invalid target provider turn identities",
		)
	}
	result.ProviderSessionID = payloadString(event.Payload, "providerSessionId")
	result.TargetProviderTurnIDs = targetTurnIDs
	result.StateBindingMode = payloadString(event.Payload, "stateBindingMode")
	result.StateBindingReceipt = payloadString(event.Payload, "stateBindingReceipt")
	result.DeliveryDisposition = SessionForkDeliveryDisposition(
		payloadString(event.Payload, "deliveryDisposition"),
	)
	if result.ProviderSessionID == "" ||
		result.ProviderSessionID == result.ForkedFromProviderSessionID ||
		result.StateBindingMode != "provider_owned" ||
		result.StateBindingReceipt == "" ||
		result.DeliveryDisposition != SessionForkDeliveryAccepted {
		result.DeliveryDisposition = SessionForkDeliveryUnknown
		return result, errors.New("claude SDK fork returned incomplete verification evidence")
	}
	return result, nil
}

func (a *ClaudeCodeSDKAdapter) statelessClaudeSDKForkRequest(
	ctx context.Context,
	session Session,
	request claudeSDKSidecarRequest,
) (claudeSDKSidecarEvent, bool, error) {
	spec, cleanup, err := prepareProviderLaunch(ctx, a.preparer, session, ProcessSpec{
		Provider:       strings.TrimSpace(session.Provider),
		AgentSessionID: session.AgentSessionID,
		RoomID:         session.RoomID,
		CWD:            session.CWD,
		Command:        claudeSDKSidecarCommand(session.Env),
		Env:            claudeSDKSidecarEnv(session),
		DirectStart:    true,
	})
	if err != nil {
		return claudeSDKSidecarEvent{}, false, err
	}
	conn, err := a.transport.Start(ctx, spec)
	if err != nil {
		cleanupPreparedLaunch(cleanup)
		return claudeSDKSidecarEvent{}, false, err
	}
	conn = wrapProviderLaunchCleanup(conn, cleanup)
	defer conn.Close()
	adapterSession := &claudeSDKAdapterSession{
		conn:   conn,
		reader: &claudeSDKLineReader{conn: conn},
	}
	if err := adapterSession.send(request); err != nil {
		return claudeSDKSidecarEvent{}, false, err
	}
	event, err := adapterSession.roundTripDirectResponse(ctx, request)
	if err != nil {
		return event, true, err
	}
	return event, true, nil
}

func claudeSDKPayloadStringList(
	payload map[string]any,
	key string,
) ([]string, bool) {
	raw, exists := payload[key]
	if !exists {
		return nil, false
	}
	values, ok := raw.([]any)
	if !ok {
		if typed, typedOK := raw.([]string); typedOK {
			values = make([]any, len(typed))
			for index := range typed {
				values[index] = typed[index]
			}
		} else {
			return nil, false
		}
	}
	result := make([]string, 0, len(values))
	seen := make(map[string]struct{}, len(values))
	for _, rawValue := range values {
		value, ok := rawValue.(string)
		value = strings.TrimSpace(value)
		if !ok || value == "" {
			return nil, false
		}
		if _, duplicate := seen[value]; duplicate {
			return nil, false
		}
		seen[value] = struct{}{}
		result = append(result, value)
	}
	return result, true
}

var _ SessionForkAdapter = (*ClaudeCodeSDKAdapter)(nil)
