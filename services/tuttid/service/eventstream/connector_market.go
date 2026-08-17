package eventstream

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"

	market "github.com/tutti-os/tutti/packages/connector/host"
)

type ConnectorMarketPublisher struct {
	Service      *Service
	CurrentScope func() market.OperationScope
}

func (publisher ConnectorMarketPublisher) PublishConnectorMarketChanged(
	ctx context.Context,
	event market.ChangedEvent,
) error {
	if publisher.Service == nil {
		return errors.New("connector market event service is unavailable")
	}
	if event.Visibility == market.OperationVisibilityAccount {
		if publisher.CurrentScope == nil ||
			publisher.CurrentScope().AccountID != event.OwnerAccountID {
			return nil
		}
		event.OwnerAccountID = ""
		event.Visibility = ""
	} else {
		// Legacy or machine-level invalidations may be broadcast, but never with
		// an operation identifier or account owner attached.
		event.OperationID = ""
		event.OwnerAccountID = ""
		event.Visibility = ""
	}
	payload, err := json.Marshal(event)
	if err != nil {
		return err
	}
	return publisher.Service.PublishFromServer(ctx, TopicConnectorMarketChanged, payload)
}

func validateConnectorMarketChangedPayload(payload []byte) error {
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.DisallowUnknownFields()
	var event market.ChangedEvent
	if err := decoder.Decode(&event); err != nil {
		return err
	}
	if event.Revision == 0 {
		return errors.New("revision must be positive")
	}
	return nil
}
