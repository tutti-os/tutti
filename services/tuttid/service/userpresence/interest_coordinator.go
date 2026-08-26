package userpresence

import (
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"

	"github.com/google/uuid"
)

const (
	DefaultMaximumPresenceUsers = 100
	DefaultControlFrameBytes    = 30 * 1024
)

var (
	ErrPresenceUserLimit  = errors.New("presence user interest limit exceeded")
	ErrPresenceFrameLimit = errors.New("presence control frame limit exceeded")
)

type PresenceSubscription struct {
	UserID         string `json:"userId"`
	SubscriptionID string `json:"subscriptionId"`
}

// InterestCoordinator owns the process-local union of all room sources. A
// subscription identifier is stable for the entire 0 -> 1 -> 0 reference
// lifecycle of one user, even when several rooms reference that user.
type InterestCoordinator struct {
	usersBySource map[string]map[string]struct{}
	memberships   map[string]string
	maximumUsers  int
	maximumBytes  int
	token         func() string
}

func NewInterestCoordinator() *InterestCoordinator {
	return &InterestCoordinator{
		usersBySource: make(map[string]map[string]struct{}),
		memberships:   make(map[string]string),
		maximumUsers:  DefaultMaximumPresenceUsers,
		maximumBytes:  DefaultControlFrameBytes,
		token:         uuid.NewString,
	}
}

type InterestMutation struct {
	Replace map[string][]string
	Remove  []string
}

type InterestChange struct {
	Added         []PresenceSubscription
	Removed       []PresenceSubscription
	Subscriptions []PresenceSubscription
}

func (c *InterestCoordinator) Apply(mutation InterestMutation) (InterestChange, error) {
	if c == nil {
		return InterestChange{}, errors.New("presence interest coordinator is unavailable")
	}
	c.ensureDefaults()
	candidate := cloneSources(c.usersBySource)
	for _, sourceID := range mutation.Remove {
		delete(candidate, strings.TrimSpace(sourceID))
	}
	for sourceID, userIDs := range mutation.Replace {
		sourceID = strings.TrimSpace(sourceID)
		if sourceID == "" {
			return InterestChange{}, errors.New("presence source id is required")
		}
		candidate[sourceID] = normalizedUserSet(userIDs)
	}

	refCounts := make(map[string]int)
	for _, users := range candidate {
		for userID := range users {
			refCounts[userID]++
		}
	}
	if len(refCounts) > c.maximumUsers {
		return InterestChange{}, fmt.Errorf("%w: %d exceeds %d", ErrPresenceUserLimit, len(refCounts), c.maximumUsers)
	}

	nextMemberships := make(map[string]string, len(refCounts))
	change := InterestChange{}
	for userID := range refCounts {
		subscriptionID := c.memberships[userID]
		if subscriptionID == "" {
			subscriptionID = c.token()
			change.Added = append(change.Added, PresenceSubscription{UserID: userID, SubscriptionID: subscriptionID})
		}
		nextMemberships[userID] = subscriptionID
	}
	for userID, subscriptionID := range c.memberships {
		if _, ok := nextMemberships[userID]; !ok {
			change.Removed = append(change.Removed, PresenceSubscription{UserID: userID, SubscriptionID: subscriptionID})
		}
	}
	change.Subscriptions = sortedSubscriptions(nextMemberships)
	if err := c.validateFrameBudget(change.Subscriptions); err != nil {
		return InterestChange{}, err
	}
	sortSubscriptions(change.Added)
	sortSubscriptions(change.Removed)
	c.usersBySource = candidate
	c.memberships = nextMemberships
	return change, nil
}

func (c *InterestCoordinator) ReplaceSourceUsers(sourceID string, userIDs []string) (InterestChange, error) {
	return c.Apply(InterestMutation{Replace: map[string][]string{sourceID: userIDs}})
}

func (c *InterestCoordinator) RemoveSource(sourceID string) (InterestChange, error) {
	return c.Apply(InterestMutation{Remove: []string{sourceID}})
}

func (c *InterestCoordinator) Subscriptions() []PresenceSubscription {
	if c == nil {
		return nil
	}
	return sortedSubscriptions(c.memberships)
}

func (c *InterestCoordinator) Reset() {
	if c == nil {
		return
	}
	c.usersBySource = make(map[string]map[string]struct{})
	c.memberships = make(map[string]string)
}

func (c *InterestCoordinator) ensureDefaults() {
	if c.usersBySource == nil {
		c.usersBySource = make(map[string]map[string]struct{})
	}
	if c.memberships == nil {
		c.memberships = make(map[string]string)
	}
	if c.maximumUsers <= 0 {
		c.maximumUsers = DefaultMaximumPresenceUsers
	}
	if c.maximumBytes <= 0 {
		c.maximumBytes = DefaultControlFrameBytes
	}
	if c.token == nil {
		c.token = uuid.NewString
	}
}

func (c *InterestCoordinator) validateFrameBudget(subscriptions []PresenceSubscription) error {
	frame, err := json.Marshal(struct {
		Action string `json:"action"`
		Data   struct {
			ConnectionGeneration string                 `json:"connectionGeneration"`
			PresenceSessionEpoch string                 `json:"presenceSessionEpoch"`
			Revision             uint64                 `json:"revision"`
			Subscriptions        []PresenceSubscription `json:"subscriptions"`
		} `json:"data"`
	}{
		Action: "presence.subscriptions.replace",
		Data: struct {
			ConnectionGeneration string                 `json:"connectionGeneration"`
			PresenceSessionEpoch string                 `json:"presenceSessionEpoch"`
			Revision             uint64                 `json:"revision"`
			Subscriptions        []PresenceSubscription `json:"subscriptions"`
		}{
			ConnectionGeneration: strings.Repeat("g", 128),
			PresenceSessionEpoch: strings.Repeat("e", 128),
			Revision:             9_007_199_254_740_991,
			Subscriptions:        subscriptions,
		},
	})
	if err != nil {
		return fmt.Errorf("encode presence control frame: %w", err)
	}
	if len(frame) > c.maximumBytes {
		return fmt.Errorf("%w: %d exceeds %d", ErrPresenceFrameLimit, len(frame), c.maximumBytes)
	}
	return nil
}

func normalizedUserSet(userIDs []string) map[string]struct{} {
	result := make(map[string]struct{}, len(userIDs))
	for _, userID := range userIDs {
		if userID = strings.TrimSpace(userID); userID != "" {
			result[userID] = struct{}{}
		}
	}
	return result
}

func cloneSources(sources map[string]map[string]struct{}) map[string]map[string]struct{} {
	result := make(map[string]map[string]struct{}, len(sources))
	for sourceID, users := range sources {
		copyUsers := make(map[string]struct{}, len(users))
		for userID := range users {
			copyUsers[userID] = struct{}{}
		}
		result[sourceID] = copyUsers
	}
	return result
}

func sortedSubscriptions(memberships map[string]string) []PresenceSubscription {
	result := make([]PresenceSubscription, 0, len(memberships))
	for userID, subscriptionID := range memberships {
		result = append(result, PresenceSubscription{UserID: userID, SubscriptionID: subscriptionID})
	}
	sortSubscriptions(result)
	return result
}

func sortSubscriptions(subscriptions []PresenceSubscription) {
	sort.Slice(subscriptions, func(i, j int) bool { return subscriptions[i].UserID < subscriptions[j].UserID })
}
