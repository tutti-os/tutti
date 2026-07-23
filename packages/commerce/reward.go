package commerce

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"sync"
	"time"
)

type loginClaimResponse struct {
	GrantNo                string            `json:"grant_no"`
	FirstLoginClaimed      bool              `json:"first_login_claimed"`
	FirstLoginGrantNo      string            `json:"first_login_grant_no"`
	FirstLoginGrantCredits loginClaimCredits `json:"first_login_grant_credits"`
	DailyClaimed           bool              `json:"daily_claimed"`
	DailyGrantNo           string            `json:"daily_grant_no"`
	DailyGrantCredits      loginClaimCredits `json:"daily_grant_credits"`
}

type loginClaimCredits int64

func (credits *loginClaimCredits) UnmarshalJSON(data []byte) error {
	if strings.TrimSpace(string(data)) == "null" {
		*credits = 0
		return nil
	}
	var number int64
	if err := json.Unmarshal(data, &number); err == nil {
		*credits = loginClaimCredits(number)
		return nil
	}
	var text string
	if err := json.Unmarshal(data, &text); err != nil {
		return err
	}
	text = strings.TrimSpace(text)
	if text == "" {
		*credits = 0
		return nil
	}
	parsed, err := strconv.ParseInt(text, 10, 64)
	if err != nil {
		return err
	}
	*credits = loginClaimCredits(parsed)
	return nil
}

type rewardCoordinator struct {
	client          *client
	store           RewardReceiptStore
	now             func() time.Time
	mu              sync.Mutex
	failClosedUsers map[string]struct{}
}

func (r *rewardCoordinator) reward(
	ctx context.Context,
	userID string,
) *RegistrationCreditsReward {
	userID = strings.TrimSpace(userID)
	if userID == "" {
		return nil
	}

	r.mu.Lock()
	defer r.mu.Unlock()

	if _, blocked := r.failClosedUsers[userID]; blocked {
		return nil
	}
	state, err := r.store.Load(ctx)
	if err != nil {
		// Fail closed: without durable receipt state the coordinator cannot
		// guarantee that a registration reward is shown at most once.
		r.failClosedUsers[userID] = struct{}{}
		return nil
	}
	if pending := visibleRegistrationCreditsReward(state, userID); pending != nil {
		return pending
	}
	if state.Attempted != nil && state.Attempted[userID] > 0 {
		return nil
	}

	claim, err := r.client.loginClaim(ctx)
	if err != nil {
		return nil
	}
	now := r.now().UTC()
	if state.Attempted == nil {
		state.Attempted = map[string]int64{}
	}
	state.Attempted[userID] = now.UnixMilli()
	if !claim.FirstLoginClaimed || claim.FirstLoginGrantCredits <= 0 {
		if err := r.store.Save(ctx, state); err != nil {
			r.failClosedUsers[userID] = struct{}{}
		}
		return nil
	}

	grantNo := strings.TrimSpace(claim.FirstLoginGrantNo)
	if grantNo == "" {
		grantNo = strings.TrimSpace(claim.GrantNo)
	}
	if grantNo == "" {
		grantNo = fmt.Sprintf("first-login-%d", now.UnixMilli())
	}
	rewardID := RegistrationCreditsRewardID(userID, grantNo)
	if state.Shown != nil && state.Shown[rewardID] > 0 {
		if err := r.store.Save(ctx, state); err != nil {
			r.failClosedUsers[userID] = struct{}{}
		}
		return nil
	}

	reward := &RegistrationCreditsReward{
		ID:        rewardID,
		UserID:    userID,
		GrantNo:   grantNo,
		Credits:   int64(claim.FirstLoginGrantCredits),
		CreatedAt: now,
	}
	state.Pending = reward
	if err := r.store.Save(ctx, state); err != nil {
		r.failClosedUsers[userID] = struct{}{}
		return nil
	}
	return cloneRegistrationCreditsReward(reward)
}

func (r *rewardCoordinator) dismiss(ctx context.Context, rewardID string) error {
	rewardID = strings.TrimSpace(rewardID)
	if rewardID == "" {
		return ErrRegistrationCreditsRewardIDRequired
	}

	r.mu.Lock()
	defer r.mu.Unlock()
	state, err := r.store.Load(ctx)
	if err != nil {
		return err
	}
	if state.Shown == nil {
		state.Shown = map[string]int64{}
	}
	state.Shown[rewardID] = r.now().UTC().UnixMilli()
	if state.Pending != nil && state.Pending.ID == rewardID {
		state.Pending = nil
	}
	return r.store.Save(ctx, state)
}

func visibleRegistrationCreditsReward(
	state RewardReceiptState,
	userID string,
) *RegistrationCreditsReward {
	if state.Pending == nil ||
		state.Pending.UserID != userID ||
		state.Pending.Credits <= 0 {
		return nil
	}
	if state.Shown != nil && state.Shown[state.Pending.ID] > 0 {
		return nil
	}
	return cloneRegistrationCreditsReward(state.Pending)
}

func RegistrationCreditsRewardID(userID string, grantNo string) string {
	return "registrationCreditsToastShown:" +
		strings.TrimSpace(userID) +
		":" +
		strings.TrimSpace(grantNo)
}

func cloneRegistrationCreditsReward(
	reward *RegistrationCreditsReward,
) *RegistrationCreditsReward {
	if reward == nil {
		return nil
	}
	cloned := *reward
	return &cloned
}

func cloneRewardReceiptState(state RewardReceiptState) RewardReceiptState {
	cloned := RewardReceiptState{
		Pending: cloneRegistrationCreditsReward(state.Pending),
	}
	if state.Shown != nil {
		cloned.Shown = make(map[string]int64, len(state.Shown))
		for key, value := range state.Shown {
			cloned.Shown[key] = value
		}
	}
	if state.Attempted != nil {
		cloned.Attempted = make(map[string]int64, len(state.Attempted))
		for key, value := range state.Attempted {
			cloned.Attempted[key] = value
		}
	}
	return cloned
}
