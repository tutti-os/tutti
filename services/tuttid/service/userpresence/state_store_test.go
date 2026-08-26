package userpresence

import (
	"testing"
	"time"
)

func TestStateStoreBuffersEventsUntilSnapshotAndReplaysByRevision(t *testing.T) {
	store := NewStateStore()
	store.BeginWatch(PresenceSubscription{UserID: "user-1", SubscriptionID: "sub-1"})
	store.BeginSync([]string{"user-1"})
	store.ApplyEvent(PresenceEvent{
		UserID: "user-1", SubscriptionID: "sub-1", Status: StatusOffline,
		AuthorityGeneration: "authority-1", PresenceRevision: "12",
	})
	store.ApplySnapshot("authority-1", true, []string{"user-1"}, []SnapshotUser{{
		UserID: "user-1", Status: StatusOnline, PresenceRevision: "11",
	}}, time.Now())
	view := store.View("user-1")
	if view.Status != StatusOffline || view.PresenceRevision != "12" || view.Availability != AvailabilityReady || !view.Authoritative {
		t.Fatalf("buffer was not replayed after snapshot: %#v", view)
	}
}

func TestStateStoreFencesSubscriptionAndAuthorityGeneration(t *testing.T) {
	store := NewStateStore()
	store.BeginWatch(PresenceSubscription{UserID: "user-1", SubscriptionID: "sub-current"})
	store.ApplySnapshot("authority-1", true, []string{"user-1"}, []SnapshotUser{{
		UserID: "user-1", Status: StatusOnline, PresenceRevision: "5",
	}}, time.Now())
	if changed, resync := store.ApplyEvent(PresenceEvent{
		UserID: "user-1", SubscriptionID: "sub-old", Status: StatusOffline,
		AuthorityGeneration: "authority-1", PresenceRevision: "6",
	}); changed || resync {
		t.Fatal("stale subscription should be ignored without resync")
	}
	if changed, resync := store.ApplyEvent(PresenceEvent{
		UserID: "user-1", SubscriptionID: "sub-current", Status: StatusOffline,
		AuthorityGeneration: "authority-2", PresenceRevision: "1",
	}); !changed || !resync {
		t.Fatal("new authority should require resync")
	}
	view := store.View("user-1")
	if view.Status != StatusOffline || view.Availability != AvailabilityUnknown || view.Authoritative {
		t.Fatalf("new authority was applied without a snapshot: %#v", view)
	}
}

func TestStateStoreRequestsAnotherSnapshotForBufferedGenerationMismatch(t *testing.T) {
	store := NewStateStore()
	store.BeginWatch(PresenceSubscription{UserID: "user-1", SubscriptionID: "sub-1"})
	store.BeginSync([]string{"user-1"})
	store.ApplyEvent(PresenceEvent{
		UserID: "user-1", SubscriptionID: "sub-1", Status: StatusOnline,
		AuthorityGeneration: "authority-2", PresenceRevision: "1",
	})
	if needsSnapshot := store.ApplySnapshot("authority-1", true, []string{"user-1"}, []SnapshotUser{{
		UserID: "user-1", Status: StatusOffline, PresenceRevision: "9",
	}}, time.Now()); !needsSnapshot {
		t.Fatal("buffered authority generation mismatch should request another snapshot")
	}
	view := store.View("user-1")
	if view.Status != StatusOffline || view.Availability != AvailabilityUnknown || view.Authoritative {
		t.Fatalf("mismatched snapshot was exposed as authoritative: %#v", view)
	}
}

func TestStateStoreProjectsNonAuthoritativeStateAsOfflineAndExpiresCache(t *testing.T) {
	store := NewStateStore()
	now := time.Now()
	store.BeginWatch(PresenceSubscription{UserID: "user-1", SubscriptionID: "sub-1"})
	store.ApplySnapshot("authority-1", true, []string{"user-1"}, []SnapshotUser{{
		UserID: "user-1", Status: StatusOnline, PresenceRevision: "1",
	}}, now)
	store.Sweep(now.Add(11 * time.Minute))
	view := store.View("user-1")
	if view.Status != StatusOffline || view.Availability != AvailabilityStale || view.Authoritative {
		t.Fatalf("stale state did not project offline: %#v", view)
	}
	store.EndWatch(PresenceSubscription{UserID: "user-1", SubscriptionID: "sub-1"}, now.Add(11*time.Minute))
	store.Sweep(now.Add(22 * time.Minute))
	if view = store.View("user-1"); view.Availability != AvailabilityNotWatched {
		t.Fatalf("expired cache was retained: %#v", view)
	}
}
