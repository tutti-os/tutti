package userpresence

import (
	"errors"
	"strings"
	"time"
)

const DefaultRoomLRUCapacity = 10

type RoomPresenceEntry struct {
	RoomID        string
	MemberUserIDs []string
	LastVisitedAt time.Time
}

type RoomPresenceLRU struct {
	capacity int
	entries  map[string]RoomPresenceEntry
	order    []string
}

func NewRoomPresenceLRU(capacity int) *RoomPresenceLRU {
	if capacity <= 0 {
		capacity = DefaultRoomLRUCapacity
	}
	return &RoomPresenceLRU{capacity: capacity, entries: make(map[string]RoomPresenceEntry)}
}

func (l *RoomPresenceLRU) Visit(roomID string, memberUserIDs []string, visitedAt time.Time) (*RoomPresenceEntry, error) {
	if l == nil {
		return nil, errors.New("room presence LRU is unavailable")
	}
	roomID = strings.TrimSpace(roomID)
	if roomID == "" {
		return nil, errors.New("room id is required")
	}
	if visitedAt.IsZero() {
		visitedAt = time.Now()
	}
	if l.entries == nil {
		l.entries = make(map[string]RoomPresenceEntry)
	}
	l.removeFromOrder(roomID)
	l.order = append([]string{roomID}, l.order...)
	l.entries[roomID] = RoomPresenceEntry{
		RoomID: roomID, MemberUserIDs: sortedUserIDs(memberUserIDs), LastVisitedAt: visitedAt,
	}
	if len(l.order) <= l.capacity {
		return nil, nil
	}
	evictedID := l.order[len(l.order)-1]
	l.order = l.order[:len(l.order)-1]
	evicted := l.entries[evictedID]
	delete(l.entries, evictedID)
	return &evicted, nil
}

func (l *RoomPresenceLRU) Entry(roomID string) (RoomPresenceEntry, bool) {
	if l == nil {
		return RoomPresenceEntry{}, false
	}
	entry, ok := l.entries[strings.TrimSpace(roomID)]
	entry.MemberUserIDs = append([]string(nil), entry.MemberUserIDs...)
	return entry, ok
}

func (l *RoomPresenceLRU) Entries() []RoomPresenceEntry {
	if l == nil {
		return nil
	}
	result := make([]RoomPresenceEntry, 0, len(l.order))
	for _, roomID := range l.order {
		entry := l.entries[roomID]
		entry.MemberUserIDs = append([]string(nil), entry.MemberUserIDs...)
		result = append(result, entry)
	}
	return result
}

func (l *RoomPresenceLRU) Clone() *RoomPresenceLRU {
	if l == nil {
		return NewRoomPresenceLRU(DefaultRoomLRUCapacity)
	}
	clone := NewRoomPresenceLRU(l.capacity)
	clone.order = append([]string(nil), l.order...)
	for roomID, entry := range l.entries {
		entry.MemberUserIDs = append([]string(nil), entry.MemberUserIDs...)
		clone.entries[roomID] = entry
	}
	return clone
}

func (l *RoomPresenceLRU) removeFromOrder(roomID string) {
	for index, candidate := range l.order {
		if candidate == roomID {
			l.order = append(l.order[:index], l.order[index+1:]...)
			return
		}
	}
}

func sortedUserIDs(userIDs []string) []string {
	set := normalizedUserSet(userIDs)
	result := make([]string, 0, len(set))
	for userID := range set {
		result = append(result, userID)
	}
	// Reuse the same ordering as subscriptions without allocating an auxiliary
	// map that would carry subscription identifiers.
	for i := 1; i < len(result); i++ {
		for j := i; j > 0 && result[j] < result[j-1]; j-- {
			result[j], result[j-1] = result[j-1], result[j]
		}
	}
	return result
}
