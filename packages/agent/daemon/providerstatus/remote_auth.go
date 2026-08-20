package providerstatus

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/tutti-os/tutti/packages/agent/daemon/httpx"
	"github.com/tutti-os/tutti/packages/agent/daemon/providerregistry"
)

const remoteAuthResponseLimit = 1024 * 1024

type RemoteAuthHTTPClient interface {
	Do(*http.Request) (*http.Response, error)
}

// RemoteAuthProbeResult contains credential-free provider evidence plus an
// optional successful response body for consumers that also project usage.
// Error is diagnostic only; callers reduce Evidence instead of mapping errors
// directly to authentication state.
type RemoteAuthProbeResult struct {
	Evidence   AuthEvidence
	StatusCode int
	Body       []byte
	Error      error
}

// ProbeRemoteAuth converts a descriptor-owned HTTP bearer request into the
// shared authentication evidence vocabulary. Only explicit provider rejection
// (401/403) revokes local configuration; rate limits, server failures and
// transport errors remain probe failures so local credentials stay launchable.
func ProbeRemoteAuth(
	ctx context.Context,
	client RemoteAuthHTTPClient,
	descriptor providerregistry.RemoteAuthProbeDescriptor,
	bearerToken string,
) RemoteAuthProbeResult {
	if ctx == nil {
		ctx = context.Background()
	}
	if client == nil {
		client = httpx.Default()
	}
	token := strings.TrimSpace(bearerToken)
	if descriptor.Kind != providerregistry.RemoteAuthProbeKindHTTPBearer || token == "" {
		return remoteAuthProbeFailure(fmt.Errorf("remote auth probe is not configured"))
	}
	probeCtx := ctx
	cancel := func() {}
	if descriptor.TimeoutSeconds > 0 {
		probeCtx, cancel = context.WithTimeout(ctx, time.Duration(descriptor.TimeoutSeconds)*time.Second)
	}
	defer cancel()

	request, err := http.NewRequestWithContext(
		probeCtx,
		strings.ToUpper(strings.TrimSpace(descriptor.Method)),
		strings.TrimSpace(descriptor.Endpoint),
		nil,
	)
	if err != nil {
		return remoteAuthProbeFailure(fmt.Errorf("build remote auth request: %w", err))
	}
	for key, value := range descriptor.Headers {
		request.Header.Set(key, value)
	}
	request.Header.Set("Authorization", "Bearer "+token)

	response, err := client.Do(request)
	if err != nil {
		return remoteAuthProbeFailure(fmt.Errorf("execute remote auth request: %w", err))
	}
	defer response.Body.Close()
	result := RemoteAuthProbeResult{StatusCode: response.StatusCode}
	switch {
	case response.StatusCode >= 200 && response.StatusCode < 300:
		body, readErr := io.ReadAll(io.LimitReader(response.Body, remoteAuthResponseLimit+1))
		if readErr != nil {
			return remoteAuthProbeFailure(fmt.Errorf("read remote auth response: %w", readErr))
		}
		if len(body) > remoteAuthResponseLimit {
			return remoteAuthProbeFailure(fmt.Errorf("remote auth response exceeds %d bytes", remoteAuthResponseLimit))
		}
		result.Body = body
		result.Evidence = AuthEvidence{Kind: AuthEvidenceRemoteSuccess}
		return result
	case response.StatusCode == http.StatusUnauthorized || response.StatusCode == http.StatusForbidden:
		result.Evidence = AuthEvidence{
			Kind:   AuthEvidenceRemoteAuthFailure,
			Reason: AuthReasonSessionExpired,
		}
		return result
	default:
		result.Evidence = AuthEvidence{Kind: AuthEvidenceProbeFailure, Reason: AuthReasonProbeFailed}
		result.Error = fmt.Errorf("remote auth endpoint returned HTTP %d", response.StatusCode)
		return result
	}
}

func remoteAuthProbeFailure(err error) RemoteAuthProbeResult {
	return RemoteAuthProbeResult{
		Evidence: AuthEvidence{Kind: AuthEvidenceProbeFailure, Reason: AuthReasonProbeFailed},
		Error:    err,
	}
}
