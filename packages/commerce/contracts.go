package commerce

import (
	"context"
	"net/http"
	"time"
)

type RequestAuthorizer interface {
	Authorize(*http.Request) error
}

type RequestAuthorizerFunc func(*http.Request) error

func (f RequestAuthorizerFunc) Authorize(request *http.Request) error {
	return f(request)
}

type MembershipSummary struct {
	TierKey           string
	DisplayName       string
	BillingPeriod     string
	Status            string
	AccessStatus      string
	CurrentPeriodEnd  string
	CancelAtPeriodEnd *bool
}

type CreditsSummary struct {
	AvailableCredits         *string
	ExpiringCreditsWithin24h *string
	NextExpireAt             string
	RefreshedAt              string
}

type ProductSummaryPartialError struct {
	Scope   string
	Code    string
	Message string
}

type RegistrationCreditsReward struct {
	ID        string
	UserID    string
	GrantNo   string
	Credits   int64
	CreatedAt time.Time
}

type ProductSummary struct {
	Membership                *MembershipSummary
	Credits                   *CreditsSummary
	RegistrationCreditsReward *RegistrationCreditsReward
	PartialError              *ProductSummaryPartialError
}

type RewardReceiptState struct {
	Pending   *RegistrationCreditsReward `json:"pending,omitempty"`
	Shown     map[string]int64           `json:"shown,omitempty"`
	Attempted map[string]int64           `json:"attempted,omitempty"`
}

type RewardReceiptStore interface {
	Load(context.Context) (RewardReceiptState, error)
	Save(context.Context, RewardReceiptState) error
}
