package userpresence

import (
	"strconv"
	"strings"
	"sync"
	"time"
)

type Status string

const (
	StatusOnline  Status = "ONLINE"
	StatusOffline Status = "OFFLINE"
)

type Availability string

const (
	AvailabilityNotWatched  Availability = "NOT_WATCHED"
	AvailabilitySubscribing Availability = "SUBSCRIBING"
	AvailabilitySyncing     Availability = "SYNCING"
	AvailabilityReady       Availability = "READY"
	AvailabilityStale       Availability = "STALE"
	AvailabilityUnknown     Availability = "UNKNOWN"
	AvailabilityDegraded    Availability = "DEGRADED"
)

type PresenceView struct {
	UserID              string       `json:"userId"`
	Status              Status       `json:"status"`
	Availability        Availability `json:"availability"`
	Authoritative       bool         `json:"authoritative"`
	AuthorityGeneration string       `json:"authorityGeneration"`
	PresenceRevision    string       `json:"presenceRevision"`
	ObservedAt          time.Time    `json:"observedAt,omitempty"`
}

type SnapshotUser struct {
	UserID           string
	Status           Status
	PresenceRevision string
	ObservedAt       time.Time
}

type PresenceEvent struct {
	UserID              string
	SubscriptionID      string
	Status              Status
	AuthorityGeneration string
	PresenceRevision    string
	ObservedAt          time.Time
}

type presenceState struct {
	PresenceView
	subscriptionID string
	buffer         []PresenceEvent
	lastConfirmed  time.Time
	staleSince     time.Time
}

type StateStore struct {
	mu            sync.RWMutex
	states        map[string]*presenceState
	maximumBuffer int
	staleAfter    time.Duration
	retainStale   time.Duration
}

func NewStateStore() *StateStore {
	return &StateStore{
		states: make(map[string]*presenceState), maximumBuffer: 64,
		staleAfter: 10 * time.Minute, retainStale: 10 * time.Minute,
	}
}

func (s *StateStore) BeginWatch(subscription PresenceSubscription) {
	if s == nil {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.ensureDefaults()
	state := s.states[subscription.UserID]
	if state == nil {
		state = &presenceState{PresenceView: PresenceView{UserID: subscription.UserID, Status: StatusOffline}}
		s.states[subscription.UserID] = state
	}
	state.subscriptionID = subscription.SubscriptionID
	state.Availability = AvailabilitySubscribing
	state.Authoritative = false
	state.buffer = nil
	state.staleSince = time.Time{}
}

func (s *StateStore) BeginSync(userIDs []string) {
	if s == nil {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.ensureDefaults()
	for _, userID := range sortedUserIDs(userIDs) {
		state := s.states[userID]
		if state == nil || state.subscriptionID == "" {
			continue
		}
		state.Availability = AvailabilitySyncing
		state.Authoritative = false
	}
}

func (s *StateStore) EndWatch(subscription PresenceSubscription, now time.Time) {
	if s == nil {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	state := s.states[subscription.UserID]
	if state == nil || state.subscriptionID != subscription.SubscriptionID {
		return
	}
	state.subscriptionID = ""
	state.Availability = AvailabilityStale
	state.Authoritative = false
	state.buffer = nil
	state.staleSince = now
}

// ApplyEvent returns whether the local projection changed and whether a
// different authority generation requires an authoritative snapshot.
func (s *StateStore) ApplyEvent(event PresenceEvent) (bool, bool) {
	if s == nil {
		return false, false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.ensureDefaults()
	state := s.states[event.UserID]
	if state == nil || state.subscriptionID == "" || state.subscriptionID != event.SubscriptionID || !validStatus(event.Status) {
		return false, false
	}
	if state.Availability == AvailabilitySubscribing || state.Availability == AvailabilitySyncing || state.AuthorityGeneration == "" {
		if len(state.buffer) >= s.maximumBuffer {
			state.buffer = nil
			state.Availability = AvailabilityUnknown
			state.Authoritative = false
			return true, true
		}
		state.buffer = append(state.buffer, event)
		return false, false
	}
	if state.AuthorityGeneration != event.AuthorityGeneration {
		state.Availability = AvailabilityUnknown
		state.Authoritative = false
		state.buffer = []PresenceEvent{event}
		return true, true
	}
	if revisionGreater(event.PresenceRevision, state.PresenceRevision) {
		applyPresenceEvent(state, event)
		state.lastConfirmed = time.Now()
		return true, false
	}
	return false, false
}

// ApplySnapshot returns true when an event buffered during the request belongs
// to a different authority generation. The snapshot is then not authoritative
// for that user and the caller must schedule another read.
func (s *StateStore) ApplySnapshot(authorityGeneration string, available bool, requestedUserIDs []string, users []SnapshotUser, now time.Time) bool {
	if s == nil {
		return false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.ensureDefaults()
	needsSnapshot := false
	byUser := make(map[string]SnapshotUser, len(users))
	for _, user := range users {
		byUser[strings.TrimSpace(user.UserID)] = user
	}
	for _, userID := range sortedUserIDs(requestedUserIDs) {
		state := s.states[userID]
		if state == nil || state.subscriptionID == "" {
			continue
		}
		if !available || strings.TrimSpace(authorityGeneration) == "" {
			state.Availability = AvailabilityDegraded
			state.Authoritative = false
			continue
		}
		user, ok := byUser[userID]
		if !ok {
			user = SnapshotUser{UserID: userID, Status: StatusOffline, PresenceRevision: "0", ObservedAt: now}
		}
		state.Status = normalizeStatus(user.Status)
		state.AuthorityGeneration = authorityGeneration
		state.PresenceRevision = normalizedRevision(user.PresenceRevision)
		state.ObservedAt = user.ObservedAt
		state.Availability = AvailabilityReady
		state.Authoritative = true
		state.lastConfirmed = now
		generationMismatch := false
		for _, event := range state.buffer {
			if event.AuthorityGeneration != authorityGeneration {
				generationMismatch = true
				continue
			}
			if revisionGreater(event.PresenceRevision, state.PresenceRevision) {
				applyPresenceEvent(state, event)
				state.lastConfirmed = now
			}
		}
		state.buffer = nil
		if generationMismatch {
			state.Availability = AvailabilityUnknown
			state.Authoritative = false
			needsSnapshot = true
		}
	}
	return needsSnapshot
}

func (s *StateStore) MarkSnapshotFailed(userIDs []string) {
	if s == nil {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, userID := range userIDs {
		if state := s.states[strings.TrimSpace(userID)]; state != nil && state.subscriptionID != "" {
			state.Availability = AvailabilityDegraded
			state.Authoritative = false
		}
	}
}

func (s *StateStore) View(userID string) PresenceView {
	if s == nil {
		return offlineView(strings.TrimSpace(userID), AvailabilityNotWatched)
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	state := s.states[strings.TrimSpace(userID)]
	if state == nil {
		return offlineView(strings.TrimSpace(userID), AvailabilityNotWatched)
	}
	view := state.PresenceView
	if !view.Authoritative {
		view.Status = StatusOffline
	}
	return view
}

func (s *StateStore) Views(userIDs []string) []PresenceView {
	result := make([]PresenceView, 0, len(userIDs))
	for _, userID := range sortedUserIDs(userIDs) {
		result = append(result, s.View(userID))
	}
	return result
}

func (s *StateStore) Sweep(now time.Time) {
	if s == nil {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.ensureDefaults()
	for userID, state := range s.states {
		if state.subscriptionID != "" && state.Authoritative && now.Sub(state.lastConfirmed) >= s.staleAfter {
			state.Availability = AvailabilityStale
			state.Authoritative = false
			state.staleSince = now
		}
		if state.subscriptionID == "" && !state.staleSince.IsZero() && now.Sub(state.staleSince) >= s.retainStale {
			delete(s.states, userID)
		}
	}
}

func (s *StateStore) Reset() {
	if s == nil {
		return
	}
	s.mu.Lock()
	s.states = make(map[string]*presenceState)
	s.mu.Unlock()
}

func (s *StateStore) ensureDefaults() {
	if s.states == nil {
		s.states = make(map[string]*presenceState)
	}
	if s.maximumBuffer <= 0 {
		s.maximumBuffer = 64
	}
	if s.staleAfter <= 0 {
		s.staleAfter = 10 * time.Minute
	}
	if s.retainStale <= 0 {
		s.retainStale = 10 * time.Minute
	}
}

func applyPresenceEvent(state *presenceState, event PresenceEvent) {
	state.Status = normalizeStatus(event.Status)
	state.PresenceRevision = normalizedRevision(event.PresenceRevision)
	state.ObservedAt = event.ObservedAt
	state.Availability = AvailabilityReady
	state.Authoritative = true
}

func revisionGreater(candidate, baseline string) bool {
	candidateRevision, candidateErr := strconv.ParseUint(strings.TrimSpace(candidate), 10, 64)
	baselineRevision, baselineErr := strconv.ParseUint(strings.TrimSpace(baseline), 10, 64)
	return candidateErr == nil && (baselineErr != nil || candidateRevision > baselineRevision)
}

func normalizedRevision(revision string) string {
	parsed, err := strconv.ParseUint(strings.TrimSpace(revision), 10, 64)
	if err != nil {
		return "0"
	}
	return strconv.FormatUint(parsed, 10)
}

func normalizeStatus(status Status) Status {
	if status == StatusOnline {
		return StatusOnline
	}
	return StatusOffline
}

func validStatus(status Status) bool { return status == StatusOnline || status == StatusOffline }

func offlineView(userID string, availability Availability) PresenceView {
	return PresenceView{UserID: userID, Status: StatusOffline, Availability: availability, Authoritative: false}
}
