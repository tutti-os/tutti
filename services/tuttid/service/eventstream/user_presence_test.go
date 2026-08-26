package eventstream

import (
	"context"
	"testing"

	userpresenceservice "github.com/tutti-os/tutti/services/tuttid/service/userpresence"
)

func TestUserPresencePublisherEmitsRendererUpdate(t *testing.T) {
	service := NewService(DefaultCatalog(), nil)
	session := service.OpenSession()
	defer service.CloseSession(session)
	if err := service.Subscribe(session, []string{TopicAccountUserPresenceUpdated}, EventScope{}); err != nil {
		t.Fatal(err)
	}
	publisher := UserPresencePublisher{Service: service}
	if err := publisher.PublishUserPresence(context.Background(), userpresenceservice.PresenceView{
		UserID: "user-1", Status: userpresenceservice.StatusOnline,
		Availability: userpresenceservice.AvailabilityReady, Authoritative: true,
		AuthorityGeneration: "authority-1", PresenceRevision: "4",
	}); err != nil {
		t.Fatal(err)
	}
	event := <-service.Events(session)
	if event.Topic != TopicAccountUserPresenceUpdated {
		t.Fatalf("topic = %q", event.Topic)
	}
}
