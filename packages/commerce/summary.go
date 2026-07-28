package commerce

import (
	"context"
	"encoding/json"
	"strconv"
	"strings"
	"time"
)

type remoteSummaryResult struct {
	userInfo        map[string]any
	creditsOverview map[string]any
	membershipErr   error
	creditsErr      error
}

func (s *Service) fetchSummary(ctx context.Context) remoteSummaryResult {
	type userInfoResult struct {
		value map[string]any
		err   error
	}
	type creditsResult struct {
		value map[string]any
		err   error
	}
	userInfoChannel := make(chan userInfoResult, 1)
	creditsChannel := make(chan creditsResult, 1)
	go func() {
		value, err := s.client.userInfo(ctx)
		userInfoChannel <- userInfoResult{value: value, err: err}
	}()
	go func() {
		value, err := s.client.creditsOverview(ctx)
		creditsChannel <- creditsResult{value: value, err: err}
	}()
	userInfo := <-userInfoChannel
	credits := <-creditsChannel
	return remoteSummaryResult{
		userInfo:        userInfo.value,
		creditsOverview: credits.value,
		membershipErr:   userInfo.err,
		creditsErr:      credits.err,
	}
}

func productSummaryPartialError(
	membershipErr error,
	creditsErr error,
) *ProductSummaryPartialError {
	if membershipErr == nil && creditsErr == nil {
		return nil
	}
	if membershipErr != nil && creditsErr != nil {
		return &ProductSummaryPartialError{
			Scope:   "unknown",
			Code:    ErrorCode(membershipErr),
			Message: safeErrorMessage(membershipErr),
		}
	}
	if membershipErr != nil {
		return &ProductSummaryPartialError{
			Scope:   "membership",
			Code:    ErrorCode(membershipErr),
			Message: safeErrorMessage(membershipErr),
		}
	}
	return &ProductSummaryPartialError{
		Scope:   "credits",
		Code:    ErrorCode(creditsErr),
		Message: safeErrorMessage(creditsErr),
	}
}

func safeErrorMessage(err error) string {
	if err == nil {
		return ""
	}
	switch ErrorCode(err) {
	case ErrorCodeUnauthorized:
		return "Commerce session is unavailable"
	case ErrorCodeTimeout:
		return "Commerce request timed out"
	default:
		return "Commerce data is unavailable"
	}
}

func MembershipSummaryFromUserInfo(data map[string]any) *MembershipSummary {
	summary, _ := MembershipFromUserInfo(data)
	return summary
}

func MembershipFromUserInfo(
	data map[string]any,
) (*MembershipSummary, MembershipAccessState) {
	if summary, access, ok := currentVIPMembershipSummary(data); ok {
		if access == MembershipAccessUnknown {
			return legacyMembershipSummary(data), access
		}
		return summary, access
	}
	summary := legacyMembershipSummary(data)
	return summary, membershipAccessState(summary)
}

func legacyMembershipSummary(data map[string]any) *MembershipSummary {
	membership, ok := objectField(data, "membership")
	if !ok {
		return nil
	}
	tierKey := stringField(membership, "tier_key", "tierKey", "tier")
	if tierKey == "" {
		return nil
	}
	summary := &MembershipSummary{
		TierKey:           tierKey,
		DisplayName:       displayPlanName(tierKey),
		BillingPeriod:     stringField(membership, "billing_period", "billingPeriod"),
		Status:            stringField(membership, "status"),
		AccessStatus:      stringField(membership, "access_status", "accessStatus", "stripe_status", "stripeStatus"),
		CurrentPeriodEnd:  stringField(membership, "current_period_end", "currentPeriodEnd", "expired_at", "expiredAt"),
		CancelAtPeriodEnd: boolFieldPointer(membership, "cancel_at_period_end", "cancelAtPeriodEnd"),
	}
	return summary
}

func membershipAccessState(summary *MembershipSummary) MembershipAccessState {
	if summary == nil {
		return MembershipAccessUnknown
	}
	if strings.EqualFold(strings.TrimSpace(summary.TierKey), "free") {
		return MembershipAccessFree
	}
	for _, status := range []string{summary.AccessStatus, summary.Status} {
		switch strings.ToLower(strings.TrimSpace(status)) {
		case "active":
			return MembershipAccessActive
		case "inactive":
			return MembershipAccessInactive
		}
	}
	return MembershipAccessUnknown
}

func currentVIPMembershipSummary(
	data map[string]any,
) (*MembershipSummary, MembershipAccessState, bool) {
	vipLevel := strings.ToLower(stringField(data, "vip_level", "vipLevel"))
	isVIP := boolFieldPointer(data, "is_vip", "isVip")
	if isVIP == nil && vipLevel == "" {
		return nil, MembershipAccessUnknown, false
	}
	if isVIP != nil && !*isVIP && (vipLevel == "" || vipLevel == "free") {
		return nil, MembershipAccessFree, true
	}
	if isVIP == nil || !*isVIP || vipLevel == "" || vipLevel == "free" {
		return nil, MembershipAccessUnknown, true
	}
	periodEnd := stringField(data, "vip_renew_at", "vipRenewAt")
	if periodEnd == "" {
		periodEnd = stringField(data, "vip_valid_until", "vipValidUntil")
	}
	return &MembershipSummary{
		TierKey:           vipLevel,
		DisplayName:       displayPlanName(vipLevel),
		BillingPeriod:     stringField(data, "vip_billing_period", "vipBillingPeriod"),
		Status:            "active",
		AccessStatus:      "active",
		CurrentPeriodEnd:  periodEnd,
		CancelAtPeriodEnd: boolFieldPointer(data, "vip_cancel_at_period_end", "vipCancelAtPeriodEnd"),
	}, MembershipAccessActive, true
}

func CreditsSummaryFromResponses(
	overview map[string]any,
	fallback map[string]any,
	now time.Time,
) *CreditsSummary {
	if len(overview) == 0 && len(fallback) == 0 {
		return nil
	}
	available := creditsStringFieldPointer(
		overview,
		"available_credits",
		"availableCredits",
		"totalAvailable",
		"balance",
	)
	if available == nil {
		available = creditsStringFieldPointer(
			fallback,
			"available_credits",
			"availableCredits",
			"credits",
		)
	}
	if available == nil {
		return nil
	}
	return &CreditsSummary{
		AvailableCredits: available,
		ExpiringCreditsWithin24h: creditsStringFieldPointer(
			overview,
			"expiring_credits_within_24h",
			"expiringCreditsWithin24h",
		),
		NextExpireAt: stringField(overview, "next_expire_at", "nextExpireAt"),
		RefreshedAt:  now.UTC().Format(time.RFC3339),
	}
}

func displayPlanName(tierKey string) string {
	switch strings.ToLower(strings.TrimSpace(tierKey)) {
	case "free":
		return "Free"
	case "basic":
		return "Basic"
	case "pro":
		return "Pro"
	case "ultra":
		return "Ultra"
	default:
		return strings.TrimSpace(tierKey)
	}
}

func objectField(data map[string]any, keys ...string) (map[string]any, bool) {
	for _, key := range keys {
		if value, ok := data[key].(map[string]any); ok {
			return value, true
		}
	}
	return nil, false
}

func boolFieldPointer(data map[string]any, keys ...string) *bool {
	for _, key := range keys {
		if value, ok := data[key].(bool); ok {
			return &value
		}
	}
	return nil
}

func stringField(data map[string]any, keys ...string) string {
	for _, key := range keys {
		if value, ok := data[key].(string); ok && strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func creditsStringFieldPointer(data map[string]any, keys ...string) *string {
	for _, key := range keys {
		switch value := data[key].(type) {
		case float64:
			result := strconv.FormatFloat(value, 'f', -1, 64)
			return &result
		case int64:
			result := strconv.FormatInt(value, 10)
			return &result
		case int:
			result := strconv.Itoa(value)
			return &result
		case json.Number:
			result := strings.TrimSpace(value.String())
			if result != "" {
				return &result
			}
		case string:
			result := strings.TrimSpace(value)
			if result != "" {
				return &result
			}
		}
	}
	return nil
}
