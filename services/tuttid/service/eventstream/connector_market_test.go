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
		market.ChangedEvent{ConnectorKey: "github", OperationID: "legacy-operation", Revision: 2},
	); err != nil {
		t.Fatal(err)
	}
	event := <-service.Events(session)
	if event.Topic != TopicConnectorMarketChanged || string(event.Payload) != `{"connectorKey":"github","revision":2}` {
		t.Fatalf("event = %#v", event)
	}
}

func TestConnectorMarketPublisherOnlyDeliversAccountOperationEventToOwner(t *testing.T) {
	service := NewService(DefaultCatalog(), nil)
	session := service.OpenSession()
	defer service.CloseSession(session)
	if err := service.Subscribe(session, []string{TopicConnectorMarketChanged}, EventScope{}); err != nil {
		t.Fatal(err)
	}
	currentAccountID := "account-b"
	publisher := ConnectorMarketPublisher{
		Service: service,
		CurrentScope: func() market.OperationScope {
			return market.OperationScope{AccountID: currentAccountID}
		},
	}
	event := market.ChangedEvent{
		ConnectorKey: "github", OperationID: "operation-a", OwnerAccountID: "account-a",
		Visibility: market.OperationVisibilityAccount, Revision: 2,
	}
	if err := publisher.PublishConnectorMarketChanged(context.Background(), event); err != nil {
		t.Fatal(err)
	}
	select {
	case leaked := <-service.Events(session):
		t.Fatalf("other account received operation event: %#v", leaked)
	default:
	}
	currentAccountID = "account-a"
	if err := publisher.PublishConnectorMarketChanged(context.Background(), event); err != nil {
		t.Fatal(err)
	}
	delivered := <-service.Events(session)
	if string(delivered.Payload) != `{"connectorKey":"github","operationId":"operation-a","revision":2}` {
		t.Fatalf("owner event = %#v", delivered)
	}
}
