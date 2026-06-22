package agent

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/tutti-os/tutti/services/tuttid/biz/agentprovider"
	agentstatusservice "github.com/tutti-os/tutti/services/tuttid/service/agentstatus"
)

const (
	ProviderAvailabilityAvailable      = "available"
	ProviderAvailabilityUnavailable    = "unavailable"
	ProviderAvailabilityUnknown        = "unknown"
	providerAvailabilityReasonFallback = "agent_provider_unavailable"
)

var ErrProviderUnavailable = errors.New("agent provider unavailable")

type ProviderUnavailableError struct {
	Provider   string
	ReasonCode string
	Message    string
}

func (e *ProviderUnavailableError) Error() string {
	if e == nil {
		return ErrProviderUnavailable.Error()
	}
	message := strings.TrimSpace(e.Message)
	if message == "" {
		message = ErrProviderUnavailable.Error()
	}
	provider := strings.TrimSpace(e.Provider)
	if provider == "" {
		return message
	}
	return fmt.Sprintf("%s: %s", provider, message)
}

func (*ProviderUnavailableError) Unwrap() error {
	return ErrProviderUnavailable
}

type ProviderAvailabilityCheck struct {
	Name   string
	Passed bool
	Detail string
}

type ProviderAvailabilityError struct {
	Code    string
	Message string
}

type ProviderAvailability struct {
	Provider   string
	Status     string
	Checks     []ProviderAvailabilityCheck
	LastError  *ProviderAvailabilityError
	CapturedAt time.Time
}

type ProviderAvailabilityInput struct {
	Provider string
}

type ProviderAvailabilityChecker interface {
	ListProviderAvailability(context.Context, []string) ([]ProviderAvailability, error)
}

type AgentStatusProviderAvailabilityChecker struct {
	Service AgentProviderStatusLister
}

type AgentProviderStatusLister interface {
	List(context.Context, agentstatusservice.ListInput) (agentstatusservice.Snapshot, error)
}

func (s *Service) ListProviderAvailability(ctx context.Context, input ProviderAvailabilityInput) ([]ProviderAvailability, error) {
	providers, err := providerAvailabilityInputProviders(input)
	if err != nil {
		return nil, err
	}
	cacheKey := providerAvailabilityCacheKey(providers)
	now := time.Now().UTC()
	if cached, ok := s.providerAvailabilityCache.get(cacheKey, now, s.providerAvailabilityCacheTTL()); ok {
		return cached, nil
	}
	checker := s.AvailabilityChecker
	if checker == nil {
		checker = AgentStatusProviderAvailabilityChecker{Service: agentstatusservice.Service{}}
	}
	availability, err := checker.ListProviderAvailability(ctx, providers)
	if errors.Is(err, agentstatusservice.ErrInvalidProvider) {
		return nil, ErrInvalidArgument
	}
	if err != nil {
		return nil, err
	}
	s.providerAvailabilityCache.set(cacheKey, now, availability)
	return cloneProviderAvailability(availability), nil
}

func (s *Service) ensureProviderRuntimeInstalled(ctx context.Context, provider string) error {
	checker := s.AvailabilityChecker
	if checker == nil {
		return nil
	}
	availability, err := checker.ListProviderAvailability(ctx, []string{provider})
	if err != nil {
		return err
	}
	for _, item := range availability {
		if providerAvailabilityNeedsInstall(item) {
			return providerUnavailableErrorFromAvailability(item)
		}
	}
	return nil
}

func providerAvailabilityInputProviders(input ProviderAvailabilityInput) ([]string, error) {
	provider := strings.TrimSpace(input.Provider)
	if provider == "" {
		return nil, nil
	}
	normalized := agentprovider.Normalize(provider)
	if normalized == "" {
		return nil, ErrInvalidArgument
	}
	return []string{normalized}, nil
}

func (s *Service) providerAvailabilityCacheTTL() time.Duration {
	if s.ProviderAvailabilityCacheTTL != 0 {
		return s.ProviderAvailabilityCacheTTL
	}
	return defaultProviderAvailabilityCacheTTL
}

func (c AgentStatusProviderAvailabilityChecker) ListProviderAvailability(
	ctx context.Context,
	providers []string,
) ([]ProviderAvailability, error) {
	service := c.Service
	if service == nil {
		service = agentstatusservice.Service{}
	}
	snapshot, err := service.List(ctx, agentstatusservice.ListInput{Providers: providers})
	if err != nil {
		return nil, err
	}
	result := make([]ProviderAvailability, 0, len(snapshot.Providers))
	for _, status := range snapshot.Providers {
		result = append(result, providerAvailabilityFromAgentStatus(snapshot.CapturedAt, status))
	}
	return result, nil
}

func providerAvailabilityFromAgentStatus(
	capturedAt time.Time,
	status agentstatusservice.ProviderStatus,
) ProviderAvailability {
	checkedAt := capturedAt
	if status.Availability.CheckedAt != nil {
		checkedAt = status.Availability.CheckedAt.UTC()
	}
	result := ProviderAvailability{
		Provider:   strings.TrimSpace(status.Provider),
		Status:     providerAvailabilityStatusFromAgentStatus(status.Availability.Status),
		Checks:     providerAvailabilityChecksFromAgentStatus(status),
		CapturedAt: checkedAt,
	}
	if result.Status != ProviderAvailabilityAvailable {
		result.LastError = providerAvailabilityErrorFromAgentStatus(status)
	}
	return result
}

func providerAvailabilityStatusFromAgentStatus(status agentstatusservice.AvailabilityStatus) string {
	switch status {
	case agentstatusservice.AvailabilityReady:
		return ProviderAvailabilityAvailable
	case agentstatusservice.AvailabilityNotInstalled,
		agentstatusservice.AvailabilityAuthRequired,
		agentstatusservice.AvailabilityUnsupported:
		return ProviderAvailabilityUnavailable
	default:
		return ProviderAvailabilityUnknown
	}
}

func providerAvailabilityChecksFromAgentStatus(status agentstatusservice.ProviderStatus) []ProviderAvailabilityCheck {
	if status.Availability.Status == agentstatusservice.AvailabilityUnsupported {
		return []ProviderAvailabilityCheck{{
			Name:   "support",
			Passed: false,
			Detail: providerAvailabilityErrorMessage(status),
		}}
	}
	return []ProviderAvailabilityCheck{
		{
			Name:   "cli",
			Passed: status.CLI.Installed,
			Detail: firstNonEmptyString(status.CLI.BinaryPath, "CLI binary not found"),
		},
		{
			Name:   "adapter",
			Passed: status.Adapter.Installed,
			Detail: firstNonEmptyString(status.Adapter.BinaryPath, "ACP adapter not found"),
		},
		{
			Name:   "auth",
			Passed: status.Auth.Status == agentstatusservice.AuthAuthenticated,
			Detail: providerAvailabilityAuthDetail(status.Auth),
		},
	}
}

func providerAvailabilityNeedsInstall(availability ProviderAvailability) bool {
	if availability.Status == ProviderAvailabilityAvailable {
		return false
	}
	for _, check := range availability.Checks {
		switch strings.TrimSpace(check.Name) {
		case "cli", "adapter":
			if !check.Passed {
				return true
			}
		}
	}
	if availability.LastError == nil {
		return false
	}
	switch strings.TrimSpace(availability.LastError.Code) {
	case "cli_not_found", "acp_adapter_not_found":
		return true
	default:
		return false
	}
}

func providerUnavailableErrorFromAvailability(availability ProviderAvailability) error {
	reasonCode := providerAvailabilityReasonFallback
	message := "agent provider runtime is unavailable"
	if availability.LastError != nil {
		if code := strings.TrimSpace(availability.LastError.Code); code != "" {
			reasonCode = code
		}
		if detail := strings.TrimSpace(availability.LastError.Message); detail != "" {
			message = detail
		}
	}
	if message == "agent provider runtime is unavailable" {
		for _, check := range availability.Checks {
			if !check.Passed && strings.TrimSpace(check.Detail) != "" {
				message = strings.TrimSpace(check.Detail)
				break
			}
		}
	}
	return &ProviderUnavailableError{
		Provider:   strings.TrimSpace(availability.Provider),
		ReasonCode: reasonCode,
		Message:    message,
	}
}

func providerAvailabilityAuthDetail(auth agentstatusservice.AuthInfo) string {
	switch auth.Status {
	case agentstatusservice.AuthAuthenticated:
		return firstNonEmptyString(auth.AccountLabel, "authenticated")
	case agentstatusservice.AuthRequired:
		return "authentication required"
	default:
		return "authentication unknown"
	}
}

func providerAvailabilityErrorFromAgentStatus(status agentstatusservice.ProviderStatus) *ProviderAvailabilityError {
	code := strings.TrimSpace(status.Availability.ReasonCode)
	if code == "" {
		code = string(status.Availability.Status)
	}
	return &ProviderAvailabilityError{
		Code:    code,
		Message: providerAvailabilityErrorMessage(status),
	}
}

func providerAvailabilityErrorMessage(status agentstatusservice.ProviderStatus) string {
	switch status.Availability.Status {
	case agentstatusservice.AvailabilityNotInstalled:
		if !status.CLI.Installed {
			return "CLI binary not found"
		}
		if !status.Adapter.Installed {
			return "ACP adapter not found"
		}
		return "provider is not installed"
	case agentstatusservice.AvailabilityAuthRequired:
		return "authentication required"
	case agentstatusservice.AvailabilityUnsupported:
		return "provider is temporarily unsupported"
	case agentstatusservice.AvailabilityUnknown:
		return "provider availability is unknown"
	default:
		return "provider is unavailable"
	}
}
