package userpresence

import (
	"context"
	"errors"
	"reflect"
	"testing"
)

type fakeRealtime struct {
	calls [][]PresenceSubscription
	err   error
	reset int
}

func (f *fakeRealtime) ReplacePresenceSubscriptions(_ context.Context, desired []PresenceSubscription) error {
	f.calls = append(f.calls, append([]PresenceSubscription(nil), desired...))
	return f.err
}

func (f *fakeRealtime) ResetPresenceSubscriptions() { f.reset++ }

type fakeSnapshots struct {
	calls [][]string
	value PresenceSnapshot
	err   error
}

func (f *fakeSnapshots) BatchGetUserPresence(_ context.Context, userIDs []string) (PresenceSnapshot, error) {
	f.calls = append(f.calls, append([]string(nil), userIDs...))
	return f.value, f.err
}

type fakeCurrentUser string

func (f fakeCurrentUser) CurrentUserID() string { return string(f) }

func TestServiceVisitsRoomWithAckBeforeSnapshotAndFiltersMembers(t *testing.T) {
	realtime := &fakeRealtime{}
	snapshots := &fakeSnapshots{value: PresenceSnapshot{
		AuthorityGeneration: "authority-1", Available: true,
		Users: []SnapshotUser{{UserID: "user-2", Status: StatusOnline, PresenceRevision: "1"}},
	}}
	service := NewService(realtime, snapshots, fakeCurrentUser("self"))
	result, err := service.VisitRoom(context.Background(), VisitRoomInput{RoomID: "room-1", Members: []RoomMemberProjection{
		{UserID: "self", MembershipActive: true, AccountPresenceCapable: true},
		{UserID: "user-2", MembershipActive: true, AccountPresenceCapable: true},
		{UserID: "invited", MembershipActive: false, AccountPresenceCapable: true},
		{UserID: "system", MembershipActive: true, AccountPresenceCapable: false},
	}})
	if err != nil {
		t.Fatal(err)
	}
	if len(realtime.calls) != 1 || len(realtime.calls[0]) != 1 || realtime.calls[0][0].UserID != "user-2" {
		t.Fatalf("unexpected realtime desired set: %#v", realtime.calls)
	}
	if !reflect.DeepEqual(snapshots.calls, [][]string{{"user-2"}}) {
		t.Fatalf("unexpected snapshot calls: %#v", snapshots.calls)
	}
	if len(result.Members) != 1 || result.Members[0].Status != StatusOnline || !result.Members[0].Authoritative {
		t.Fatalf("unexpected room snapshot: %#v", result)
	}
}

func TestServiceRetainsDesiredStateWhenRealtimeAckFails(t *testing.T) {
	realtime := &fakeRealtime{err: errors.New("disconnected")}
	service := NewService(realtime, &fakeSnapshots{}, fakeCurrentUser("self"))
	result, err := service.VisitRoom(context.Background(), VisitRoomInput{RoomID: "room-1", Members: []RoomMemberProjection{{
		UserID: "user-1", MembershipActive: true, AccountPresenceCapable: true,
	}}})
	if err == nil {
		t.Fatal("expected realtime failure")
	}
	if len(service.Interests.Subscriptions()) != 1 {
		t.Fatal("desired set should remain available for reconnect replay")
	}
	if len(result.Members) != 1 || result.Members[0].Status != StatusOffline || result.Members[0].Availability != AvailabilityDegraded {
		t.Fatalf("failed sync should be non-authoritative offline: %#v", result)
	}
}

func TestServiceResetClearsRealtimeDesiredSet(t *testing.T) {
	realtime := &fakeRealtime{}
	service := NewService(realtime, &fakeSnapshots{}, fakeCurrentUser("self"))
	if _, err := service.VisitRoom(context.Background(), VisitRoomInput{RoomID: "room-1", Members: []RoomMemberProjection{{
		UserID: "user-1", MembershipActive: true, AccountPresenceCapable: true,
	}}}); err != nil {
		t.Fatal(err)
	}
	service.Reset()
	room := service.RoomSnapshot("room-1")
	if realtime.reset != 1 || len(service.Interests.Subscriptions()) != 0 || len(room.Members) != 0 {
		t.Fatalf("presence reset did not clear local and realtime desired state: reset=%d subscriptions=%v", realtime.reset, service.Interests.Subscriptions())
	}
}
