package commerce

import (
	"context"
	"time"
)

type Service struct {
	client  *client
	rewards *rewardCoordinator
	now     func() time.Time
}

func NewService(config Config) (*Service, error) {
	client, err := newClient(config)
	if err != nil {
		return nil, err
	}
	if config.RewardReceiptStore == nil {
		return nil, ErrRewardReceiptStoreRequired
	}
	now := config.Now
	if now == nil {
		now = time.Now
	}
	return &Service{
		client: client,
		rewards: &rewardCoordinator{
			client:          client,
			store:           config.RewardReceiptStore,
			now:             now,
			failClosedUsers: make(map[string]struct{}),
		},
		now: now,
	}, nil
}

func (s *Service) ProductSummary(ctx context.Context, userID string) ProductSummary {
	reward := s.rewards.reward(ctx, userID)
	remote := s.fetchSummary(ctx)
	return ProductSummary{
		Membership: MembershipSummaryFromUserInfo(remote.userInfo),
		Credits: CreditsSummaryFromResponses(
			remote.creditsOverview,
			remote.userInfo,
			s.now(),
		),
		RegistrationCreditsReward: reward,
		PartialError: productSummaryPartialError(
			remote.membershipErr,
			remote.creditsErr,
		),
	}
}

func (s *Service) DismissRegistrationCreditsReward(
	ctx context.Context,
	rewardID string,
) error {
	return s.rewards.dismiss(ctx, rewardID)
}
