package userpresence

import (
	"context"
	"errors"
	"fmt"
	"math/rand"
	"strings"
	"sync"
	"time"
)

const defaultSnapshotInterval = 5 * time.Minute

type Realtime interface {
	// ReplacePresenceSubscriptions returns only after the exact desired set is
	// ACKed. Implementations keep the desired set for reconnect replay even when
	// the caller's context ends while waiting.
	ReplacePresenceSubscriptions(context.Context, []PresenceSubscription) error
	// ResetPresenceSubscriptions starts a fresh process-local subscription
	// epoch and retains an empty desired set for the next connection. Account
	// logout/login must never replay room interests from the prior session.
	ResetPresenceSubscriptions()
}

type SnapshotSource interface {
	BatchGetUserPresence(context.Context, []string) (PresenceSnapshot, error)
}

type CurrentUserSource interface {
	CurrentUserID() string
}

type UpdatePublisher interface {
	PublishUserPresence(context.Context, PresenceView) error
}

type PresenceSnapshot struct {
	AuthorityGeneration string
	Available           bool
	Users               []SnapshotUser
}

// RoomMemberProjection contains the two room-domain decisions needed by the
// Presence module. It deliberately does not duplicate room membership enums.
type RoomMemberProjection struct {
	UserID                 string
	MembershipActive       bool
	AccountPresenceCapable bool
}

type VisitRoomInput struct {
	RoomID  string
	Members []RoomMemberProjection
}

type RoomPresenceSnapshot struct {
	RoomID  string
	Members []PresenceView
}

type Service struct {
	Realtime      Realtime
	Snapshots     SnapshotSource
	CurrentUser   CurrentUserSource
	Rooms         *RoomPresenceLRU
	Interests     *InterestCoordinator
	States        *StateStore
	Publisher     UpdatePublisher
	SnapshotEvery time.Duration

	mu            sync.RWMutex
	currentRoomID string
	foreground    bool
	cancel        context.CancelFunc
	done          chan struct{}
	snapshotWake  chan struct{}
}

func NewService(realtime Realtime, snapshots SnapshotSource, currentUser CurrentUserSource) *Service {
	return &Service{
		Realtime: realtime, Snapshots: snapshots, CurrentUser: currentUser,
		Rooms: NewRoomPresenceLRU(DefaultRoomLRUCapacity), Interests: NewInterestCoordinator(),
		States: NewStateStore(), foreground: true, snapshotWake: make(chan struct{}, 1),
	}
}

func (s *Service) VisitRoom(ctx context.Context, input VisitRoomInput) (RoomPresenceSnapshot, error) {
	if s == nil || s.Realtime == nil || s.Snapshots == nil || s.Interests == nil || s.Rooms == nil || s.States == nil {
		return RoomPresenceSnapshot{}, errors.New("user presence service is not configured")
	}
	roomID := strings.TrimSpace(input.RoomID)
	if roomID == "" {
		return RoomPresenceSnapshot{}, errors.New("room id is required")
	}
	memberUserIDs := s.filterMembers(input.Members)

	s.mu.Lock()
	candidateRooms := s.Rooms.Clone()
	evicted, err := candidateRooms.Visit(roomID, memberUserIDs, time.Now())
	if err != nil {
		s.mu.Unlock()
		return RoomPresenceSnapshot{}, err
	}
	mutation := InterestMutation{Replace: map[string][]string{roomSourceID(roomID): memberUserIDs}}
	if evicted != nil {
		mutation.Remove = []string{roomSourceID(evicted.RoomID)}
	}
	change, err := s.Interests.Apply(mutation)
	if err != nil {
		s.mu.Unlock()
		return degradedRoomSnapshot(roomID, memberUserIDs), err
	}
	s.Rooms = candidateRooms
	s.currentRoomID = roomID
	for _, added := range change.Added {
		s.States.BeginWatch(added)
	}
	for _, removed := range change.Removed {
		s.States.EndWatch(removed, time.Now())
	}
	s.mu.Unlock()

	// The shared realtime owner retains this desired set and serializes it with
	// any in-flight replace. Snapshot sync begins only after its exact ACK.
	if err := s.Realtime.ReplacePresenceSubscriptions(ctx, change.Subscriptions); err != nil {
		s.States.MarkSnapshotFailed(memberUserIDs)
		return s.RoomSnapshot(roomID), fmt.Errorf("commit presence interests: %w", err)
	}
	if err := s.syncUsers(ctx, memberUserIDs); err != nil {
		return s.RoomSnapshot(roomID), err
	}
	return s.RoomSnapshot(roomID), nil
}

func (s *Service) RoomSnapshot(roomID string) RoomPresenceSnapshot {
	roomID = strings.TrimSpace(roomID)
	if s == nil || s.Rooms == nil || s.States == nil {
		return RoomPresenceSnapshot{RoomID: roomID}
	}
	s.mu.RLock()
	entry, ok := s.Rooms.Entry(roomID)
	s.mu.RUnlock()
	if !ok {
		return RoomPresenceSnapshot{RoomID: roomID}
	}
	return RoomPresenceSnapshot{RoomID: roomID, Members: s.States.Views(entry.MemberUserIDs)}
}

func (s *Service) HandleEvent(event PresenceEvent) {
	if s == nil || s.States == nil {
		return
	}
	changed, needsSnapshot := s.States.ApplyEvent(event)
	if changed {
		s.publishView(s.States.View(event.UserID))
	}
	if needsSnapshot {
		s.wakeSnapshot()
	}
}

func (s *Service) SetForeground(foreground bool) {
	if s == nil {
		return
	}
	s.mu.Lock()
	changed := s.foreground != foreground
	s.foreground = foreground
	s.mu.Unlock()
	if changed && foreground {
		s.wakeSnapshot()
	}
}

func (s *Service) ReconcileCurrentRoom() {
	s.wakeSnapshot()
}

func (s *Service) Start() {
	if s == nil {
		return
	}
	s.mu.Lock()
	if s.cancel != nil {
		s.mu.Unlock()
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	s.cancel = cancel
	s.done = done
	if s.snapshotWake == nil {
		s.snapshotWake = make(chan struct{}, 1)
	}
	s.mu.Unlock()
	go s.run(ctx, done)
}

func (s *Service) Stop(ctx context.Context) {
	if s == nil {
		return
	}
	s.mu.RLock()
	cancel, done := s.cancel, s.done
	s.mu.RUnlock()
	if cancel == nil || done == nil {
		return
	}
	cancel()
	select {
	case <-done:
	case <-ctx.Done():
	}
}

func (s *Service) Reset() {
	if s == nil {
		return
	}
	s.mu.Lock()
	s.Rooms = NewRoomPresenceLRU(DefaultRoomLRUCapacity)
	s.Interests.Reset()
	s.States.Reset()
	s.currentRoomID = ""
	s.mu.Unlock()
	if s.Realtime != nil {
		s.Realtime.ResetPresenceSubscriptions()
	}
}

func (s *Service) run(ctx context.Context, done chan struct{}) {
	defer func() {
		s.mu.Lock()
		if s.done == done {
			s.cancel = nil
			s.done = nil
		}
		s.mu.Unlock()
		close(done)
	}()
	interval := s.SnapshotEvery
	if interval <= 0 {
		interval = defaultSnapshotInterval
	}
	timer := time.NewTimer(jitterSnapshotInterval(interval))
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-s.snapshotWake:
			s.syncCurrentRoom(ctx)
		case <-timer.C:
			s.mu.RLock()
			foreground := s.foreground
			s.mu.RUnlock()
			if foreground {
				s.syncCurrentRoom(ctx)
			}
			timer.Reset(jitterSnapshotInterval(interval))
		}
	}
}

func (s *Service) syncCurrentRoom(ctx context.Context) {
	s.mu.RLock()
	roomID := s.currentRoomID
	entry, ok := s.Rooms.Entry(roomID)
	s.mu.RUnlock()
	if ok {
		_ = s.syncUsers(ctx, entry.MemberUserIDs)
	}
}

func (s *Service) syncUsers(ctx context.Context, userIDs []string) error {
	if len(userIDs) == 0 {
		return nil
	}
	s.States.BeginSync(userIDs)
	snapshot, err := s.Snapshots.BatchGetUserPresence(ctx, userIDs)
	if err != nil {
		s.States.MarkSnapshotFailed(userIDs)
		return fmt.Errorf("batch get user presence: %w", err)
	}
	needsSnapshot := s.States.ApplySnapshot(snapshot.AuthorityGeneration, snapshot.Available, userIDs, snapshot.Users, time.Now())
	for _, view := range s.States.Views(userIDs) {
		s.publishView(view)
	}
	if needsSnapshot {
		s.wakeSnapshot()
	}
	return nil
}

func (s *Service) filterMembers(members []RoomMemberProjection) []string {
	currentUserID := ""
	if s.CurrentUser != nil {
		currentUserID = strings.TrimSpace(s.CurrentUser.CurrentUserID())
	}
	result := make([]string, 0, len(members))
	for _, member := range members {
		userID := strings.TrimSpace(member.UserID)
		if userID == "" || userID == currentUserID || !member.MembershipActive || !member.AccountPresenceCapable {
			continue
		}
		result = append(result, userID)
	}
	return sortedUserIDs(result)
}

func (s *Service) wakeSnapshot() {
	if s == nil {
		return
	}
	s.mu.RLock()
	wake := s.snapshotWake
	s.mu.RUnlock()
	if wake != nil {
		select {
		case wake <- struct{}{}:
		default:
		}
	}
}

func (s *Service) publishView(view PresenceView) {
	if s.Publisher == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := s.Publisher.PublishUserPresence(ctx, view); err != nil {
		// Presence delivery is a projection hint. The local GET endpoint remains
		// available when the renderer event stream is temporarily backpressured.
		return
	}
}

func roomSourceID(roomID string) string { return "room:" + strings.TrimSpace(roomID) }

func degradedRoomSnapshot(roomID string, userIDs []string) RoomPresenceSnapshot {
	result := RoomPresenceSnapshot{RoomID: roomID, Members: make([]PresenceView, 0, len(userIDs))}
	for _, userID := range sortedUserIDs(userIDs) {
		result.Members = append(result.Members, offlineView(userID, AvailabilityDegraded))
	}
	return result
}

func jitterSnapshotInterval(interval time.Duration) time.Duration {
	delta := interval / 10
	if delta <= 0 {
		return interval
	}
	return interval - delta + time.Duration(rand.Int63n(int64(delta*2)+1))
}
