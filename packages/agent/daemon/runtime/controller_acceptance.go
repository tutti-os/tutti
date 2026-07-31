package agentruntime

import (
	"context"
	"errors"
	"strings"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

// ProviderTurnAcceptanceInput is an authoritative history observation. This
// path only repairs the durable projection; it never dispatches provider work.
type ProviderTurnAcceptanceInput struct {
	RoomID                    string
	AgentSessionID            string
	Provider                  string
	RootTurnID                string
	ExpectedProviderSessionID string
	ExpectedProviderTurnID    string
	// ClientUserMessageID is opaque provider correlation evidence and must be
	// distinct from the canonical RootTurnID.
	ClientUserMessageID string
}

func (c *Controller) ReconcileProviderTurnAcceptance(
	ctx context.Context,
	input ProviderTurnAcceptanceInput,
) error {
	input.RoomID = strings.TrimSpace(input.RoomID)
	input.AgentSessionID = strings.TrimSpace(input.AgentSessionID)
	input.Provider = strings.TrimSpace(input.Provider)
	input.RootTurnID = strings.TrimSpace(input.RootTurnID)
	input.ExpectedProviderSessionID = strings.TrimSpace(input.ExpectedProviderSessionID)
	input.ExpectedProviderTurnID = strings.TrimSpace(input.ExpectedProviderTurnID)
	input.ClientUserMessageID = strings.TrimSpace(input.ClientUserMessageID)
	if c == nil || input.RoomID == "" || input.AgentSessionID == "" ||
		input.RootTurnID == "" || input.ExpectedProviderSessionID == "" ||
		input.ExpectedProviderTurnID == "" ||
		input.ClientUserMessageID == "" ||
		input.ClientUserMessageID == input.RootTurnID {
		return errors.New("valid provider turn acceptance evidence is required")
	}
	session, found := c.get(input.RoomID, input.AgentSessionID)
	if !found {
		return ErrSessionNotFound
	}
	if strings.TrimSpace(session.ProviderSessionID) != input.ExpectedProviderSessionID ||
		(input.Provider != "" && strings.TrimSpace(session.Provider) != input.Provider) {
		return errors.New("provider turn acceptance session identity changed")
	}
	eventContext, ok := activityEventContext(
		session,
		"root-provider-turn-started:"+input.ExpectedProviderTurnID,
		input.RootTurnID,
	)
	if !ok {
		return ErrSessionDisconnected
	}
	accepted := activityshared.NewRootProviderTurnStarted(
		eventContext,
		input.RootTurnID,
		input.ExpectedProviderTurnID,
	)
	accepted.Payload.ProviderTurnBindingJSON = c.providerTurnBindingJSON(
		ctx,
		session,
		ProviderTurnBindingWriteInput{
			Kind:           ProviderTurnBindingWriteRecovered,
			ProviderTurnID: input.ExpectedProviderTurnID,
		},
	)
	accepted.Payload.Metadata = map[string]any{
		"acceptanceSource": string(AcceptanceSourceHistoryRead),
	}
	reported, err := c.reportProviderAcceptanceDurable(
		ctx,
		session,
		[]activityshared.Event{accepted},
	)
	if err != nil {
		return err
	}
	if !reported {
		return errors.New("durable provider acceptance reporter is unavailable")
	}
	return nil
}
