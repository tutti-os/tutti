package eventstream

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"

	market "github.com/tutti-os/tutti/packages/connector/market/daemon"
)

type ConnectorMarketPublisher struct {
	Service *Service
}

func (publisher ConnectorMarketPublisher) PublishConnectorMarketChanged(
	ctx context.Context,
	event market.ChangedEvent,
) error {
	if publisher.Service == nil {
		return errors.New("connector market event service is unavailable")
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
