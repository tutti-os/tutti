package agentruntime

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"

	"github.com/tutti-os/tutti/packages/agent/daemon/runtime/codexproto"
)

type codexForkThreadReadResponse struct {
	Thread *codexproto.Thread `json:"thread,omitempty"`
}

type appServerForkStrategy struct {
	userAgentBrand            string
	throughTurnMinimumVersion [3]int
}

func (a *CodexAppServerAdapter) forkStrategy() (appServerForkStrategy, bool) {
	if a == nil || !a.config.nativeSessionFork {
		return appServerForkStrategy{}, false
	}
	minimumVersion, ok := parseVersionTriplet(
		a.config.sessionForkThroughTurnMinVersion,
	)
	userAgentBrand := strings.TrimSpace(a.config.sessionForkUserAgentBrand)
	if !ok || userAgentBrand == "" {
		return appServerForkStrategy{}, false
	}
	return appServerForkStrategy{
		userAgentBrand:            userAgentBrand,
		throughTurnMinimumVersion: minimumVersion,
	}, true
}

func (a *CodexAppServerAdapter) ForkCapabilities(
	_ context.Context,
	source Session,
) (SessionForkCapabilities, error) {
	strategy, ok := a.forkStrategy()
	if !ok {
		return SessionForkCapabilities{}, nil
	}
	sourceThreadID := strings.TrimSpace(source.ProviderSessionID)
	a.mu.Lock()
	appSession := a.sessions[strings.TrimSpace(source.AgentSessionID)]
	if appSession != nil && appSession.client != nil &&
		appSession.threadID == sourceThreadID {
		serverInfo := clonePayload(appSession.serverInfo)
		a.mu.Unlock()
		if version, ok := appServerForkVersion(strategy, serverInfo); ok {
			return appServerForkCapabilitiesForVersion(strategy, version), nil
		}
	} else {
		a.mu.Unlock()
	}
	persistedServerInfo, _ := source.RuntimeContext["agent"].(map[string]any)
	version, ok := appServerForkVersion(strategy, persistedServerInfo)
	if !ok {
		return SessionForkCapabilities{}, nil
	}
	return appServerForkCapabilitiesForVersion(strategy, version), nil
}

func appServerForkCapabilitiesForVersion(
	strategy appServerForkStrategy,
	version [3]int,
) SessionForkCapabilities {
	return SessionForkCapabilities{
		StateBindingMode: "host_copy",
		// The provider protocol can fork a whole thread, but Tutti must not
		// advertise that structural capability until the Host/API/Engine/UI
		// full-session Point is end-to-end. Capabilities describe the product
		// chain, not an isolated provider method.
		FullSession: false,
		ThroughTurn: versionAtLeast(
			version,
			strategy.throughTurnMinimumVersion,
		),
	}
}

func readCodexForkSourceTurnIDs(
	ctx context.Context,
	client *codexAppServerClient,
	sourceThreadID string,
) ([]string, error) {
	if client == nil || sourceThreadID == "" {
		return nil, errors.New("codex fork source thread is required")
	}
	raw, err := client.ThreadReadNoHandler(
		ctx,
		acpStartCallTimeout,
		map[string]any{"threadId": sourceThreadID, "includeTurns": true},
	)
	if err != nil {
		return nil, fmt.Errorf("read codex fork source thread: %w", err)
	}
	var response codexForkThreadReadResponse
	if err := json.Unmarshal(raw, &response); err != nil {
		return nil, fmt.Errorf("decode thread/read response: %w", err)
	}
	if response.Thread == nil ||
		strings.TrimSpace(response.Thread.ID) != sourceThreadID {
		return nil, errors.New("thread/read returned an unexpected source thread")
	}
	turnIDs := make([]string, 0, len(response.Thread.Turns))
	for _, turn := range response.Thread.Turns {
		turnID := strings.TrimSpace(turn.ID)
		if turnID == "" {
			return nil, errors.New("thread/read returned an empty provider turn id")
		}
		turnIDs = append(turnIDs, turnID)
	}
	return turnIDs, nil
}

func (a *CodexAppServerAdapter) Fork(
	ctx context.Context,
	input SessionForkInput,
) (result SessionForkResult, err error) {
	source := input.Source
	sourceThreadID := strings.TrimSpace(source.ProviderSessionID)
	if sourceThreadID == "" {
		return sessionForkNotStarted(), errors.New("source provider session id is required")
	}
	providerTurnID := strings.TrimSpace(input.ProviderTurnID)
	strategy, supportedProvider := a.forkStrategy()
	if !supportedProvider || providerTurnID == "" {
		return sessionForkNotStarted(), ErrSessionForkUnsupported
	}

	// Use a short-lived app-server connection for the mutation. thread/fork
	// auto-subscribes its caller to the child; closing this connection avoids a
	// stale child listener on the source session after canonical commit attaches
	// the child through its own thread/resume connection.
	trace := newCodexAppServerStartupTrace(source, a.startupSpanObserver, nil)
	defer func() {
		trace.Finish(err)
	}()
	client, initializeResult, err := a.startInitializedClient(ctx, source, trace)
	if err != nil {
		return sessionForkNotStarted(), err
	}
	defer client.Close()
	if version, ok := appServerInitializeForkVersion(
		strategy,
		initializeResult,
	); !ok || !versionAtLeast(
		version,
		strategy.throughTurnMinimumVersion,
	) {
		return sessionForkNotStarted(), ErrSessionForkUnsupported
	}
	actualProviderTurnIDs, err := readCodexForkSourceTurnIDs(
		ctx,
		client,
		sourceThreadID,
	)
	if err != nil {
		return SessionForkResult{
			DeliveryDisposition: SessionForkDeliveryNotStarted,
		}, err
	}
	boundaryAvailable := slicesContainExact(
		actualProviderTurnIDs,
		providerTurnID,
	)
	if !boundaryAvailable {
		return SessionForkResult{
				DeliveryDisposition: SessionForkDeliveryNotStarted,
			}, fmt.Errorf(
				"codex fork boundary is unavailable in source thread: got provider turn prefix %q, want %q",
				actualProviderTurnIDs,
				providerTurnID,
			)
	}

	params := map[string]any{"threadId": sourceThreadID}
	if providerTurnID != "" {
		params["lastTurnId"] = providerTurnID
	}
	raw, err := trace.TypedCall(
		acpStartCallTimeout,
		appServerMethodThreadFork,
		func() (json.RawMessage, error) {
			return client.ThreadFork(ctx, acpStartCallTimeout, params, nil)
		},
	)
	if err != nil {
		var callErr *acpCallError
		if errors.As(err, &callErr) {
			return SessionForkResult{
				DeliveryDisposition: SessionForkDeliveryRejected,
			}, err
		}
		return SessionForkResult{
			DeliveryDisposition: SessionForkDeliveryUnknown,
		}, err
	}
	var response codexproto.ThreadForkResponse
	if err := json.Unmarshal(raw, &response); err != nil {
		return sessionForkUnknown(), fmt.Errorf("decode thread/fork response: %w", err)
	}
	if response.Thread == nil {
		return sessionForkUnknown(), errors.New("thread/fork response omitted thread")
	}
	childThreadID := strings.TrimSpace(response.Thread.ID)
	if childThreadID == "" {
		return sessionForkUnknown(), errors.New("thread/fork response returned empty thread id")
	}
	if childThreadID == sourceThreadID {
		return sessionForkUnknown(), errors.New("thread/fork returned the source thread id")
	}
	if response.Thread.ForkedFromID == nil {
		return sessionForkUnknown(), errors.New(
			"thread/fork response omitted forkedFromId",
		)
	}
	forkedFromID := strings.TrimSpace(*response.Thread.ForkedFromID)
	if forkedFromID == "" {
		return sessionForkUnknown(), errors.New(
			"thread/fork response returned empty forkedFromId",
		)
	}
	if forkedFromID != sourceThreadID {
		return sessionForkUnknown(), fmt.Errorf(
			"thread/fork lineage mismatch: got %q, want %q",
			forkedFromID,
			sourceThreadID,
		)
	}
	if providerTurnID != "" {
		actualProviderTurnIDs := make([]string, 0, len(response.Thread.Turns))
		for _, turn := range response.Thread.Turns {
			actualProviderTurnIDs = append(
				actualProviderTurnIDs,
				strings.TrimSpace(turn.ID),
			)
		}
		if !slicesContainExact(actualProviderTurnIDs, providerTurnID) {
			return sessionForkUnknown(), fmt.Errorf(
				"thread/fork omitted selected provider turn: got %q, want %q",
				actualProviderTurnIDs,
				providerTurnID,
			)
		}
	}
	return SessionForkResult{
		ProviderSessionID:           childThreadID,
		ForkedFromProviderSessionID: sourceThreadID,
		ThroughProviderTurnID:       providerTurnID,
		DeliveryDisposition:         SessionForkDeliveryAccepted,
	}, nil
}

func slicesContainExact(values []string, expected string) bool {
	for _, value := range values {
		if value == expected {
			return true
		}
	}
	return false
}

func sessionForkNotStarted() SessionForkResult {
	return SessionForkResult{DeliveryDisposition: SessionForkDeliveryNotStarted}
}

func sessionForkUnknown() SessionForkResult {
	return SessionForkResult{DeliveryDisposition: SessionForkDeliveryUnknown}
}

func appServerInitializeForkVersion(
	strategy appServerForkStrategy,
	raw json.RawMessage,
) ([3]int, bool) {
	return appServerForkVersion(
		strategy,
		func() map[string]any {
			var result map[string]any
			if json.Unmarshal(raw, &result) != nil {
				return nil
			}
			return result
		}(),
	)
}

func appServerForkVersion(
	strategy appServerForkStrategy,
	serverInfo map[string]any,
) ([3]int, bool) {
	userAgent := strings.TrimSpace(asString(serverInfo["userAgent"]))
	normalizedUserAgent := strings.ReplaceAll(
		strings.ToLower(userAgent),
		"_",
		"-",
	)
	normalizedBrand := strings.ReplaceAll(
		strings.ToLower(strings.TrimSpace(strategy.userAgentBrand)),
		"_",
		"-",
	)
	if normalizedBrand == "" ||
		!strings.Contains(normalizedUserAgent, normalizedBrand) {
		return [3]int{}, false
	}
	return appServerUserAgentVersion(userAgent)
}

func appServerUserAgentVersion(userAgent string) ([3]int, bool) {
	fields := strings.FieldsFunc(userAgent, func(r rune) bool {
		return r == '/' || r == ' '
	})
	for index := len(fields) - 1; index >= 0; index-- {
		if version, ok := parseVersionTriplet(fields[index]); ok {
			return version, true
		}
	}
	return [3]int{}, false
}

func parseVersionTriplet(value string) ([3]int, bool) {
	value = strings.TrimSpace(strings.TrimPrefix(value, "v"))
	parts := strings.SplitN(value, "-", 2)
	segments := strings.Split(parts[0], ".")
	if len(segments) != 3 {
		return [3]int{}, false
	}
	var version [3]int
	for index, segment := range segments {
		parsed, err := strconv.Atoi(segment)
		if err != nil || parsed < 0 {
			return [3]int{}, false
		}
		version[index] = parsed
	}
	return version, true
}

func versionAtLeast(version, minimum [3]int) bool {
	for index := range version {
		if version[index] != minimum[index] {
			return version[index] > minimum[index]
		}
	}
	return true
}
