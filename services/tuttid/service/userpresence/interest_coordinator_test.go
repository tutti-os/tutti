package userpresence

import (
	"errors"
	"fmt"
	"testing"
)

func TestInterestCoordinatorKeepsTokenAcrossRoomReferences(t *testing.T) {
	coordinator := NewInterestCoordinator()
	next := 0
	coordinator.token = func() string { next++; return fmt.Sprintf("sub-%d", next) }
	first, err := coordinator.ReplaceSourceUsers("room:one", []string{"user-1", "user-2"})
	if err != nil {
		t.Fatal(err)
	}
	token := first.Subscriptions[0].SubscriptionID
	if _, err := coordinator.ReplaceSourceUsers("room:two", []string{"user-1"}); err != nil {
		t.Fatal(err)
	}
	removed, err := coordinator.RemoveSource("room:one")
	if err != nil {
		t.Fatal(err)
	}
	if len(removed.Subscriptions) != 1 || removed.Subscriptions[0].UserID != "user-1" || removed.Subscriptions[0].SubscriptionID != token {
		t.Fatalf("shared membership changed unexpectedly: %#v", removed.Subscriptions)
	}
	if len(removed.Removed) != 1 || removed.Removed[0].UserID != "user-2" {
		t.Fatalf("wrong removed users: %#v", removed.Removed)
	}
}

func TestInterestCoordinatorRejectsQuotaAtomically(t *testing.T) {
	coordinator := NewInterestCoordinator()
	coordinator.maximumUsers = 2
	if _, err := coordinator.ReplaceSourceUsers("room:one", []string{"user-1", "user-2"}); err != nil {
		t.Fatal(err)
	}
	_, err := coordinator.ReplaceSourceUsers("room:two", []string{"user-3"})
	if !errors.Is(err, ErrPresenceUserLimit) {
		t.Fatalf("expected quota error, got %v", err)
	}
	current := coordinator.Subscriptions()
	if len(current) != 2 || current[0].UserID != "user-1" || current[1].UserID != "user-2" {
		t.Fatalf("rejected mutation changed committed desired set: %#v", current)
	}
}

func TestInterestCoordinatorAppliesEvictionAndInsertionAtomically(t *testing.T) {
	coordinator := NewInterestCoordinator()
	coordinator.maximumUsers = 2
	if _, err := coordinator.ReplaceSourceUsers("room:old", []string{"user-1", "user-2"}); err != nil {
		t.Fatal(err)
	}
	change, err := coordinator.Apply(InterestMutation{
		Replace: map[string][]string{"room:new": {"user-2", "user-3"}},
		Remove:  []string{"room:old"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(change.Subscriptions) != 2 || change.Subscriptions[0].UserID != "user-2" || change.Subscriptions[1].UserID != "user-3" {
		t.Fatalf("unexpected desired set: %#v", change.Subscriptions)
	}
}
