package streamgo

import (
	"context"
	"testing"
)

type fakeCatalog struct{}

func (fakeCatalog) TopicVersion(string) (int, bool)                 { return 1, true }
func (fakeCatalog) ValidatePublish(string, Direction, []byte) error { return nil }
func (fakeCatalog) ValidateSubscription(string) error               { return nil }

func TestClosedSessionRejectsFurtherEnqueueWithoutPanic(t *testing.T) {
	t.Parallel()

	service := NewService[string](fakeCatalog{}, nil, nil)
	session := service.OpenSession()
	service.CloseSession(session)

	if session.enqueue(PublishedEvent[string]{Topic: "topic.x"}) {
		t.Fatal("enqueue() = true, want false for a closed session")
	}
}

func TestScopeRoutingDeliversAndFilters(t *testing.T) {
	t.Parallel()

	service := NewService[string](fakeCatalog{}, nil, nil)
	scoped := service.OpenSession()
	other := service.OpenSession()
	wildcard := service.OpenSession()

	if err := service.Subscribe(scoped, []string{"topic.x"}, "room-1"); err != nil {
		t.Fatalf("subscribe scoped: %v", err)
	}
	if err := service.Subscribe(other, []string{"topic.x"}, "room-2"); err != nil {
		t.Fatalf("subscribe other: %v", err)
	}
	if err := service.Subscribe(wildcard, []string{"topic.x"}, ""); err != nil {
		t.Fatalf("subscribe wildcard: %v", err)
	}

	if err := service.PublishFromServerScoped(context.Background(), "topic.x", []byte(`{}`), "room-1"); err != nil {
		t.Fatalf("publish: %v", err)
	}

	if got := receive(t, scoped); got.Scope != "room-1" {
		t.Fatalf("scoped session scope = %q, want room-1", got.Scope)
	}
	if got := receive(t, wildcard); got.Scope != "room-1" {
		t.Fatalf("wildcard session scope = %q, want room-1", got.Scope)
	}
	select {
	case ev := <-other.Events():
		t.Fatalf("other-scoped session unexpectedly received %#v", ev)
	default:
	}
}

func receive(t *testing.T, session *Session[string]) PublishedEvent[string] {
	t.Helper()
	select {
	case event := <-session.Events():
		return event
	default:
		t.Fatal("event not received")
	}
	return PublishedEvent[string]{}
}
