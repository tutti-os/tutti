package eventstream

import (
	"context"
	"testing"

	market "github.com/tutti-os/tutti/packages/connector/host"
)

func TestConnectorMarketPublisherUsesCatalogTopic(t *testing.T) {
	service := NewService(DefaultCatalog(), nil)
	session := service.OpenSession()
	defer service.CloseSession(session)
	if err := service.Subscribe(session, []string{TopicConnectorMarketChanged}, EventScope{}); err != nil {
		t.Fatal(err)
	}
	if err := (ConnectorMarketPublisher{Service: service}).PublishConnectorMarketChanged(
		context.Background(),
		market.ChangedEvent{ConnectorKey: "github", Revision: 2},
	); err != nil {
		t.Fatal(err)
	}
	event := <-service.Events(session)
	if event.Topic != TopicConnectorMarketChanged || string(event.Payload) != `{"connectorKey":"github","revision":2}` {
		t.Fatalf("event = %#v", event)
	}
}
