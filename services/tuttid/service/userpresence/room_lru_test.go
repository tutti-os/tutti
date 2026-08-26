package userpresence

import (
	"fmt"
	"testing"
	"time"
)

func TestRoomPresenceLRUEvictsLeastRecentlyVisitedRoom(t *testing.T) {
	lru := NewRoomPresenceLRU(10)
	now := time.Date(2026, 8, 24, 0, 0, 0, 0, time.UTC)
	for index := 1; index <= 10; index++ {
		if evicted, err := lru.Visit(fmt.Sprintf("room-%02d", index), []string{fmt.Sprintf("user-%02d", index)}, now); err != nil || evicted != nil {
			t.Fatalf("visit %d: evicted=%#v err=%v", index, evicted, err)
		}
	}
	if _, err := lru.Visit("room-01", []string{"user-updated"}, now.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	evicted, err := lru.Visit("room-11", []string{"user-11"}, now.Add(2*time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	if evicted == nil || evicted.RoomID != "room-02" {
		t.Fatalf("expected room-02 eviction, got %#v", evicted)
	}
	entry, ok := lru.Entry("room-01")
	if !ok || len(entry.MemberUserIDs) != 1 || entry.MemberUserIDs[0] != "user-updated" {
		t.Fatalf("revisited room was not refreshed: %#v", entry)
	}
}
