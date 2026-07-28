package agentruntime

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/tutti-os/tutti/packages/agent/daemon/runtime/codexproto"
	"github.com/tutti-os/tutti/packages/agent/daemon/runtimecmd"
)

// lastTurnId first appears on the stable app-server surface shipped by the
// 0.144 line. Unknown or non-Codex runtimes fail closed even when they share
// the app-server adapter. A prerelease of a later core version keeps that core
// protocol level (for example the Codex build bundled with ChatGPT.app).
var (
	codexThroughTurnMinimumVersion = [3]int{0, 144, 0}
)

const codexForkCapabilityCacheCapacity = 32

type codexForkThreadReadResponse struct {
	Thread *codexproto.Thread `json:"thread,omitempty"`
}

func (a *CodexAppServerAdapter) ForkCapabilities(
	ctx context.Context,
	source Session,
) (SessionForkCapabilities, error) {
	if a == nil || !a.config.nativeSessionFork {
		return SessionForkCapabilities{}, nil
	}
	sourceThreadID := strings.TrimSpace(source.ProviderSessionID)
	a.mu.Lock()
	appSession := a.sessions[strings.TrimSpace(source.AgentSessionID)]
	if appSession != nil && appSession.client != nil &&
		appSession.threadID == sourceThreadID {
		client := appSession.client
		serverInfo := clonePayload(appSession.serverInfo)
		a.mu.Unlock()
		if version, ok := codexAppServerUserAgentVersion(serverInfo); ok {
			capabilities := codexForkCapabilitiesForVersion(version)
			if !capabilities.ThroughTurn {
				return capabilities, nil
			}
			providerTurnIDs, err := readCodexForkSourceTurnIDs(
				ctx,
				client,
				sourceThreadID,
			)
			if err == nil {
				capabilities.ThroughProviderTurnIDs = providerTurnIDs
				capabilities.ThroughProviderTurnIDsKnown = true
				return capabilities, nil
			}
		}
	} else {
		a.mu.Unlock()
	}
	version, providerTurnIDs, ok, err := a.probeHistoricalForkState(ctx, source)
	if err != nil || !ok {
		return SessionForkCapabilities{}, err
	}
	capabilities := codexForkCapabilitiesForVersion(version)
	if capabilities.ThroughTurn {
		capabilities.ThroughProviderTurnIDs = providerTurnIDs
		capabilities.ThroughProviderTurnIDsKnown = true
	}
	return capabilities, nil
}

func codexForkCapabilitiesForVersion(version [3]int) SessionForkCapabilities {
	return SessionForkCapabilities{
		StateBindingMode: "host_copy",
		// The provider protocol can fork a whole thread, but Tutti must not
		// advertise that structural capability until the Host/API/Engine/UI
		// full-session Point is end-to-end. Capabilities describe the product
		// chain, not an isolated provider method.
		FullSession: false,
		ThroughTurn: versionAtLeast(version, codexThroughTurnMinimumVersion),
	}
}

func (a *CodexAppServerAdapter) probeHistoricalForkState(
	ctx context.Context,
	source Session,
) ([3]int, []string, bool, error) {
	a.forkCapabilityMu.Lock()
	defer a.forkCapabilityMu.Unlock()
	trace := newCodexAppServerStartupTrace(source)
	var probeErr error
	defer func() { trace.Finish(probeErr) }()
	spec, cleanup, err := a.prepareInitializedClientLaunch(ctx, source)
	if err != nil {
		probeErr = err
		return [3]int{}, nil, false, err
	}
	fingerprint, cacheable := codexForkLaunchFingerprint(spec)
	if cacheable {
		if version, cached := a.cachedForkCapabilityVersion(fingerprint); cached &&
			!versionAtLeast(version, codexThroughTurnMinimumVersion) {
			cleanupPreparedLaunch(cleanup)
			return version, nil, true, nil
		}
	}
	client, initializeResult, err := a.startInitializedClientPrepared(
		ctx, source, trace, spec, cleanup,
	)
	if err != nil {
		probeErr = err
		return [3]int{}, nil, false, err
	}
	defer client.Close()
	version, ok := codexAppServerInitializeVersion(initializeResult)
	if !ok {
		return [3]int{}, nil, false, nil
	}
	if cacheable {
		a.cacheForkCapabilityVersion(fingerprint, version)
	}
	if !versionAtLeast(version, codexThroughTurnMinimumVersion) {
		return version, nil, true, nil
	}
	providerTurnIDs, err := readCodexForkSourceTurnIDs(
		ctx,
		client,
		strings.TrimSpace(source.ProviderSessionID),
	)
	if err != nil {
		probeErr = err
		return [3]int{}, nil, false, err
	}
	return version, providerTurnIDs, true, nil
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

func codexForkLaunchFingerprint(spec ProcessSpec) (string, bool) {
	if len(spec.Command) == 0 || strings.TrimSpace(spec.Command[0]) == "" {
		return "", false
	}
	resolver := runtimecmd.Resolver{}
	env := resolver.Env(spec.Env)
	executable := resolver.Resolve(spec.Command[0], env)
	commandBase := strings.TrimSuffix(
		strings.ToLower(filepath.Base(executable)),
		".exe",
	)
	if commandBase != codexAppServerExecutableBase {
		// Shell/package-manager wrappers can select different Codex bytes from
		// cwd or mutable package state that this layer cannot prove.
		return "", false
	}
	resolvedExecutable, err := filepath.EvalSymlinks(executable)
	if err != nil || !codexNativeExecutable(resolvedExecutable) {
		// npm/pnpm installs commonly expose a "codex" symlink whose final
		// target is a JavaScript shebang wrapper. Its selected native payload
		// depends on mutable package state, so only the initialize response may
		// attest that launch and the result must not enter the cache.
		return "", false
	}
	info, err := os.Stat(resolvedExecutable)
	if err != nil || !info.Mode().IsRegular() {
		return "", false
	}
	identity := ""
	if spec.ExecutableIdentity != nil {
		identity = fmt.Sprintf(
			"%s:%d",
			strings.TrimSpace(spec.ExecutableIdentity.SHA256),
			spec.ExecutableIdentity.SizeBytes,
		)
	}
	encoded, err := json.Marshal(struct {
		Command    []string `json:"command"`
		Cwd        string   `json:"cwd"`
		Env        []string `json:"env"`
		Executable string   `json:"executable"`
		Identity   string   `json:"identity"`
		Mode       uint32   `json:"mode"`
		ModTime    int64    `json:"modTime"`
		Size       int64    `json:"size"`
	}{
		Command:    spec.Command,
		Cwd:        strings.TrimSpace(spec.CWD),
		Env:        env,
		Executable: resolvedExecutable,
		Identity:   identity,
		Mode:       uint32(info.Mode()),
		ModTime:    info.ModTime().UnixNano(),
		Size:       info.Size(),
	})
	if err != nil {
		return "", false
	}
	digest := sha256.Sum256(encoded)
	return fmt.Sprintf("%x", digest[:]), true
}

func codexNativeExecutable(path string) bool {
	file, err := os.Open(path)
	if err != nil {
		return false
	}
	defer file.Close()
	var magic [4]byte
	if _, err := file.Read(magic[:]); err != nil {
		return false
	}
	switch magic {
	case [4]byte{0x7f, 'E', 'L', 'F'}, // ELF
		[4]byte{0xfe, 0xed, 0xfa, 0xce}, // Mach-O 32-bit, big endian
		[4]byte{0xce, 0xfa, 0xed, 0xfe}, // Mach-O 32-bit, little endian
		[4]byte{0xfe, 0xed, 0xfa, 0xcf}, // Mach-O 64-bit, big endian
		[4]byte{0xcf, 0xfa, 0xed, 0xfe}, // Mach-O 64-bit, little endian
		[4]byte{0xca, 0xfe, 0xba, 0xbe}, // universal Mach-O
		[4]byte{0xbe, 0xba, 0xfe, 0xca}, // reversed universal Mach-O
		[4]byte{0xca, 0xfe, 0xba, 0xbf}, // universal Mach-O 64-bit
		[4]byte{0xbf, 0xba, 0xfe, 0xca}: // reversed universal Mach-O 64-bit
		return true
	}
	// PE/COFF starts with the DOS MZ header. Full descriptor verification, when
	// configured, remains owned by the process transport.
	return magic[0] == 'M' && magic[1] == 'Z'
}

// cachedForkCapabilityVersion and cacheForkCapabilityVersion are called while
// forkCapabilityMu is held. The bounded LRU stores only SHA-256 keys, never the
// launch environment or other prepared runtime material.
func (a *CodexAppServerAdapter) cachedForkCapabilityVersion(
	fingerprint string,
) ([3]int, bool) {
	version, ok := a.forkCapabilityVersions[fingerprint]
	if !ok {
		return [3]int{}, false
	}
	a.touchForkCapabilityFingerprint(fingerprint)
	return version, true
}

func (a *CodexAppServerAdapter) cacheForkCapabilityVersion(
	fingerprint string,
	version [3]int,
) {
	if a.forkCapabilityVersions == nil {
		a.forkCapabilityVersions = make(map[string][3]int)
	}
	if _, exists := a.forkCapabilityVersions[fingerprint]; exists {
		a.forkCapabilityVersions[fingerprint] = version
		a.touchForkCapabilityFingerprint(fingerprint)
		return
	}
	if len(a.forkCapabilityOrder) >= codexForkCapabilityCacheCapacity {
		evicted := a.forkCapabilityOrder[0]
		delete(a.forkCapabilityVersions, evicted)
		copy(a.forkCapabilityOrder, a.forkCapabilityOrder[1:])
		a.forkCapabilityOrder = a.forkCapabilityOrder[:len(a.forkCapabilityOrder)-1]
	}
	a.forkCapabilityVersions[fingerprint] = version
	a.forkCapabilityOrder = append(a.forkCapabilityOrder, fingerprint)
}

func (a *CodexAppServerAdapter) touchForkCapabilityFingerprint(
	fingerprint string,
) {
	for index, candidate := range a.forkCapabilityOrder {
		if candidate != fingerprint {
			continue
		}
		copy(
			a.forkCapabilityOrder[index:],
			a.forkCapabilityOrder[index+1:],
		)
		a.forkCapabilityOrder[len(a.forkCapabilityOrder)-1] = fingerprint
		return
	}
	a.forkCapabilityOrder = append(a.forkCapabilityOrder, fingerprint)
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
	if a == nil || !a.config.nativeSessionFork || providerTurnID == "" {
		return sessionForkNotStarted(), ErrSessionForkUnsupported
	}

	// Use a short-lived app-server connection for the mutation. thread/fork
	// auto-subscribes its caller to the child; closing this connection avoids a
	// stale child listener on the source session after canonical commit attaches
	// the child through its own thread/resume connection.
	trace := newCodexAppServerStartupTrace(source)
	defer func() {
		trace.Finish(err)
	}()
	client, initializeResult, err := a.startInitializedClient(ctx, source, trace)
	if err != nil {
		return sessionForkNotStarted(), err
	}
	defer client.Close()
	minimumVersion := codexThroughTurnMinimumVersion
	if version, ok := codexAppServerInitializeVersion(initializeResult); !ok ||
		!versionAtLeast(version, minimumVersion) {
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
	expectedProviderTurnIDs := normalizedProviderTurnIDs(
		input.ProviderTurnIDs,
		providerTurnID,
	)
	boundaryAvailable := providerTurnID == ""
	if providerTurnID != "" {
		if len(input.ProviderTurnIDs) == 0 {
			boundaryAvailable = slicesContainExact(
				actualProviderTurnIDs,
				providerTurnID,
			)
		} else {
			boundaryAvailable = hasProviderTurnPrefix(
				actualProviderTurnIDs,
				expectedProviderTurnIDs,
			)
		}
	}
	if !boundaryAvailable {
		return SessionForkResult{
				DeliveryDisposition: SessionForkDeliveryNotStarted,
			}, fmt.Errorf(
				"codex fork boundary is unavailable in source thread: got provider turn prefix %q, want %q",
				actualProviderTurnIDs,
				expectedProviderTurnIDs,
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
		if !equalProviderTurnPrefix(actualProviderTurnIDs, expectedProviderTurnIDs) {
			return sessionForkUnknown(), fmt.Errorf(
				"thread/fork returned provider turn prefix %q, want %q",
				actualProviderTurnIDs,
				expectedProviderTurnIDs,
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

func hasProviderTurnPrefix(actual, expected []string) bool {
	return len(expected) > 0 &&
		len(actual) >= len(expected) &&
		equalProviderTurnPrefix(actual[:len(expected)], expected)
}

func sessionForkNotStarted() SessionForkResult {
	return SessionForkResult{DeliveryDisposition: SessionForkDeliveryNotStarted}
}

func sessionForkUnknown() SessionForkResult {
	return SessionForkResult{DeliveryDisposition: SessionForkDeliveryUnknown}
}

func normalizedProviderTurnIDs(values []string, fallback string) []string {
	result := make([]string, 0, len(values))
	seen := make(map[string]struct{}, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" {
			continue
		}
		if _, duplicate := seen[value]; duplicate {
			return nil
		}
		seen[value] = struct{}{}
		result = append(result, value)
	}
	if len(result) == 0 && strings.TrimSpace(fallback) != "" {
		return []string{strings.TrimSpace(fallback)}
	}
	return result
}

func equalProviderTurnPrefix(actual, expected []string) bool {
	if len(actual) == 0 || len(actual) != len(expected) {
		return false
	}
	seen := make(map[string]struct{}, len(actual))
	for index, value := range actual {
		if value == "" || value != expected[index] {
			return false
		}
		if _, duplicate := seen[value]; duplicate {
			return false
		}
		seen[value] = struct{}{}
	}
	return true
}

func codexAppServerInitializeVersion(raw json.RawMessage) ([3]int, bool) {
	return codexAppServerUserAgentVersion(
		func() map[string]any {
			var result map[string]any
			if json.Unmarshal(raw, &result) != nil {
				return nil
			}
			return result
		}(),
	)
}

func codexAppServerUserAgentVersion(serverInfo map[string]any) ([3]int, bool) {
	userAgent := strings.TrimSpace(asString(serverInfo["userAgent"]))
	if userAgent == "" || !strings.Contains(strings.ToLower(userAgent), "codex") {
		return [3]int{}, false
	}
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
