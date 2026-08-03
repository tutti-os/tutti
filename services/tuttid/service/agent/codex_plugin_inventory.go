package agent

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"path/filepath"
	"slices"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/tutti-os/tutti/packages/agent/daemon/providerregistry"
	"github.com/tutti-os/tutti/packages/agent/daemon/runtimecmd"
	"github.com/tutti-os/tutti/services/tuttid/biz/agentprovider"
	workspacedata "github.com/tutti-os/tutti/services/tuttid/data/workspace"
)

// App Server plugin methods are experimental. Keep every use in this Codex
// adapter and behind the daemon snapshot so Composer reads never wait for it.
const (
	codexPluginInventoryTimeout      = 8 * time.Second
	codexPluginInventoryPrimeTimeout = 20 * time.Second
	codexPluginInventoryReadTimeout  = 2 * time.Second
	codexPluginInventoryStaleTTL     = 5 * time.Minute
	codexPluginInventoryMaxEntries   = 128
)

var (
	ErrComposerPluginInventoryTargetNotFound = errors.New("composer plugin inventory agent target not found")
	ErrComposerPluginInventoryUnavailable    = errors.New("composer plugin inventory is unavailable")
)

type codexPluginInventoryRecord struct {
	option                ComposerPluginOption
	pluginID              string
	pluginName            string
	marketplacePath       string
	remoteMarketplaceName string
	marketplaceIsRemote   bool
	sourceRoot            string
}

type codexPluginInventoryResult struct {
	records     []codexPluginInventoryRecord
	errors      []string
	diagnostics []string
}

type codexPluginInventoryListFunc func(
	context.Context,
	string,
) codexPluginInventoryResult

type codexAppServerPluginInventoryLister struct {
	command string
	args    []string
	timeout time.Duration
}

type codexPluginInventoryScope struct {
	agentTargetID string
	provider      string
	cwd           string
	command       string
	args          []string
}

// PrimeComposerPluginInventory starts a bounded refresh. It is intentionally
// non-blocking: callers may invoke it while mounting a Composer, but a slash
// request only reads the latest completed daemon snapshot.
func (s *Service) PrimeComposerPluginInventory(
	ctx context.Context,
	input ComposerPluginOptionsInput,
) error {
	scope, err := s.resolveCodexPluginInventoryScope(ctx, input)
	if err != nil {
		return err
	}
	s.pluginInventoryCache.prime(scope, codexPluginInventoryPrimeTimeout)
	return nil
}

// GetComposerPluginOptions is a snapshot read. A missing or stale entry may
// schedule a background refresh, but this call never waits for Codex App
// Server, so plain input, `$`, and `/` cannot inherit plugin discovery delay.
func (s *Service) GetComposerPluginOptions(
	ctx context.Context,
	input ComposerPluginOptionsInput,
) (ComposerPluginOptions, error) {
	scope, err := s.resolveCodexPluginInventoryScope(ctx, input)
	if err != nil {
		return ComposerPluginOptions{}, err
	}
	plugins, partial, refresh := s.pluginInventoryCache.snapshot(scope.cacheKey())
	if refresh {
		// A snapshot read never waits for discovery. It can, however, schedule a
		// singleflight refresh when the daemon has no value or is serving stale
		// last-known-good data.
		s.pluginInventoryCache.prime(scope, codexPluginInventoryPrimeTimeout)
	}
	return ComposerPluginOptions{
		Provider: scope.provider,
		Partial:  partial,
		Plugins:  composerPluginOptionsFromRecords(plugins),
	}, nil
}

func (s *Service) resolveCodexPluginInventoryScope(
	ctx context.Context,
	input ComposerPluginOptionsInput,
) (codexPluginInventoryScope, error) {
	provider := agentprovider.Normalize(input.Provider)
	agentTargetID := strings.TrimSpace(input.AgentTargetID)
	if provider == "" || agentTargetID == "" {
		return codexPluginInventoryScope{}, ErrInvalidArgument
	}
	if !strings.HasPrefix(agentTargetID, workspaceAgentIDPrefix) {
		if s.AgentTargetStore == nil {
			return codexPluginInventoryScope{}, ErrComposerPluginInventoryUnavailable
		}
		if _, err := s.AgentTargetStore.GetAgentTarget(ctx, agentTargetID); err != nil {
			if errors.Is(err, workspacedata.ErrAgentTargetNotFound) {
				return codexPluginInventoryScope{}, ErrComposerPluginInventoryTargetNotFound
			}
			return codexPluginInventoryScope{}, fmt.Errorf("get agent target for plugin inventory: %w", err)
		}
	}
	launchInput := CreateSessionInput{AgentTargetID: agentTargetID, Provider: provider}
	launch, err := s.resolveCreateSessionLaunch(ctx, "", &launchInput)
	if err != nil {
		return codexPluginInventoryScope{}, err
	}
	provider = agentprovider.NormalizeOpen(launch.Provider)
	profile := composerProfileFor(provider)
	if profile.PluginCatalogKind != providerregistry.PluginCatalogKindCodexAppServer {
		return codexPluginInventoryScope{}, ErrInvalidArgument
	}
	if len(profile.CapabilityCatalogCommand) == 0 || strings.TrimSpace(profile.CapabilityCatalogCommand[0]) == "" {
		return codexPluginInventoryScope{}, fmt.Errorf("codex plugin inventory command is required")
	}
	resolvedTargetID := strings.TrimSpace(launchInput.HarnessAgentTargetID)
	if resolvedTargetID == "" {
		resolvedTargetID = agentTargetID
	}
	return codexPluginInventoryScope{
		agentTargetID: resolvedTargetID,
		provider:      provider,
		cwd:           canonicalCodexPluginInventoryCwd(input.Cwd),
		command:       strings.TrimSpace(profile.CapabilityCatalogCommand[0]),
		args:          append([]string(nil), profile.CapabilityCatalogCommand[1:]...),
	}, nil
}

func (scope codexPluginInventoryScope) cacheKey() string {
	return strings.Join([]string{
		"codex-plugin-inventory",
		scope.agentTargetID,
		scope.provider,
		scope.cwd,
		scope.command,
		strings.Join(scope.args, "\x00"),
	}, "\n")
}

func canonicalCodexPluginInventoryCwd(cwd string) string {
	cwd = strings.TrimSpace(cwd)
	if cwd == "" {
		return ""
	}
	abs, err := filepath.Abs(cwd)
	if err != nil {
		return filepath.Clean(cwd)
	}
	return filepath.Clean(abs)
}

func composerPluginOptionsFromRecords(
	records []codexPluginInventoryRecord,
) []ComposerPluginOption {
	options := make([]ComposerPluginOption, 0, len(records))
	for _, record := range records {
		option := record.option
		option.BundledSkills = cloneComposerPluginBundledSkills(option.BundledSkills)
		options = append(options, option)
	}
	return options
}

func cloneComposerPluginBundledSkills(
	skills []ComposerPluginBundledSkill,
) []ComposerPluginBundledSkill {
	return append([]ComposerPluginBundledSkill(nil), skills...)
}

func cloneCodexPluginInventoryRecords(
	records []codexPluginInventoryRecord,
) []codexPluginInventoryRecord {
	cloned := append([]codexPluginInventoryRecord(nil), records...)
	for index := range cloned {
		cloned[index].option.BundledSkills = cloneComposerPluginBundledSkills(
			cloned[index].option.BundledSkills,
		)
	}
	return cloned
}

type codexPluginInventoryCache struct {
	mu      sync.Mutex
	entries map[string]codexPluginInventoryCacheEntry
	flights map[string]struct{}
}

type codexPluginInventoryCacheEntry struct {
	freshUntil  time.Time
	staleUntil  time.Time
	lastSuccess []codexPluginInventoryRecord
	partial     []codexPluginInventoryRecord
	retryAfter  time.Time
	failures    int
}

func newCodexPluginInventoryCache() *codexPluginInventoryCache {
	return &codexPluginInventoryCache{
		entries: make(map[string]codexPluginInventoryCacheEntry),
		flights: make(map[string]struct{}),
	}
}

func (c *codexPluginInventoryCache) snapshot(
	key string,
) ([]codexPluginInventoryRecord, bool, bool) {
	if c == nil {
		return unknownCodexPluginInventoryRecords(), true, false
	}
	now := time.Now().UTC()
	c.mu.Lock()
	defer c.mu.Unlock()
	entry, ok := c.entries[key]
	if !ok {
		return unknownCodexPluginInventoryRecords(), true, true
	}
	if len(entry.lastSuccess) > 0 {
		if !now.After(entry.freshUntil) {
			return cloneCodexPluginInventoryRecords(entry.lastSuccess), false, false
		}
		if !now.After(entry.staleUntil) {
			return cloneCodexPluginInventoryRecords(entry.lastSuccess), false, true
		}
	}
	if len(entry.partial) > 0 && !now.After(entry.retryAfter) {
		return mergeUnknownCodexPluginInventoryRecords(entry.partial), true, false
	}
	if _, refreshing := c.flights[key]; !refreshing {
		delete(c.entries, key)
	}
	return unknownCodexPluginInventoryRecords(), true, true
}

func (c *codexPluginInventoryCache) prime(
	scope codexPluginInventoryScope,
	timeout time.Duration,
) {
	c.primeWithLister(scope, timeout, func(ctx context.Context, cwd string) codexPluginInventoryResult {
		return (codexAppServerPluginInventoryLister{
			command: scope.command,
			args:    scope.args,
			timeout: codexPluginInventoryTimeout,
		}).ListPluginInventory(ctx, cwd)
	})
}

func (c *codexPluginInventoryCache) primeWithLister(
	scope codexPluginInventoryScope,
	timeout time.Duration,
	list codexPluginInventoryListFunc,
) {
	if c == nil {
		return
	}
	key := scope.cacheKey()
	now := time.Now().UTC()
	c.mu.Lock()
	if _, exists := c.entries[key]; !exists && len(c.entries)+len(c.flights) >= codexPluginInventoryMaxEntries {
		c.evictOldestEntryLocked()
		if len(c.entries)+len(c.flights) >= codexPluginInventoryMaxEntries {
			// All capacity is currently reserved by in-flight refreshes. Preserve
			// those singleflight operations and let this scope retry on its next
			// snapshot read instead of allowing unbounded growth.
			c.mu.Unlock()
			return
		}
	}
	entry := c.entries[key]
	if (len(entry.lastSuccess) > 0 && !now.After(entry.freshUntil)) ||
		(!entry.retryAfter.IsZero() && now.Before(entry.retryAfter)) {
		c.mu.Unlock()
		return
	}
	if _, running := c.flights[key]; running {
		c.mu.Unlock()
		return
	}
	c.flights[key] = struct{}{}
	previousFailures := entry.failures
	c.mu.Unlock()

	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), timeout)
		defer cancel()
		result := list(ctx, scope.cwd)
		logCodexPluginInventoryRefresh(scope, result)
		completedAt := time.Now().UTC()
		c.mu.Lock()
		defer c.mu.Unlock()
		defer delete(c.flights, key)
		updated := c.entries[key]
		if len(result.errors) == 0 {
			updated.lastSuccess = cloneCodexPluginInventoryRecords(result.records)
			updated.partial = nil
			updated.failures = 0
			updated.retryAfter = time.Time{}
			updated.freshUntil = completedAt.Add(defaultCapabilityCatalogCacheTTL)
			updated.staleUntil = completedAt.Add(codexPluginInventoryStaleTTL)
		} else {
			updated.partial = cloneCodexPluginInventoryRecords(result.records)
			updated.failures = previousFailures + 1
			updated.retryAfter = completedAt.Add(codexPluginInventoryRetryDelay(updated.failures))
		}
		c.entries[key] = updated
	}()
}

func (c *codexPluginInventoryCache) evictOldestEntryLocked() {
	var candidateKey string
	var candidateUntil time.Time
	for key, entry := range c.entries {
		if _, refreshing := c.flights[key]; refreshing {
			continue
		}
		usefulUntil := entry.staleUntil
		if entry.retryAfter.After(usefulUntil) {
			usefulUntil = entry.retryAfter
		}
		if candidateKey == "" || usefulUntil.Before(candidateUntil) {
			candidateKey = key
			candidateUntil = usefulUntil
		}
	}
	if candidateKey != "" {
		delete(c.entries, candidateKey)
	}
}

func logCodexPluginInventoryRefresh(scope codexPluginInventoryScope, result codexPluginInventoryResult) {
	if len(result.errors) == 0 && len(result.diagnostics) == 0 {
		return
	}
	attributes := []any{
		"provider", scope.provider,
		"agent_target_id", scope.agentTargetID,
		"failure_kinds", codexPluginInventoryLogKinds(result.errors),
		"diagnostic_kinds", codexPluginInventoryLogKinds(result.diagnostics),
	}
	if len(result.errors) > 0 {
		slog.Warn("codex plugin inventory refresh failed", attributes...)
		return
	}
	slog.Warn("codex plugin inventory refresh completed with diagnostics", attributes...)
}

func codexPluginInventoryLogKinds(messages []string) []string {
	kinds := make([]string, 0, len(messages))
	for _, message := range messages {
		value := strings.ToLower(strings.TrimSpace(message))
		switch {
		case strings.Contains(value, "stderr"):
			kinds = append(kinds, "app_server_stderr")
		case strings.Contains(value, "timed out"):
			kinds = append(kinds, "timeout")
		case strings.Contains(value, "plugin/list"):
			kinds = append(kinds, "plugin_list_failed")
		case strings.Contains(value, "plugin/read") && strings.Contains(value, "missing"):
			kinds = append(kinds, "plugin_read_missing")
		case strings.Contains(value, "plugin/read"):
			kinds = append(kinds, "plugin_read_failed")
		case strings.Contains(value, "initialize"):
			kinds = append(kinds, "initialize_failed")
		case strings.Contains(value, "stop codex"):
			kinds = append(kinds, "process_stop_failed")
		default:
			kinds = append(kinds, "discovery_failed")
		}
	}
	sort.Strings(kinds)
	return slices.Compact(kinds)
}

func codexPluginInventoryRetryDelay(failures int) time.Duration {
	switch failures {
	case 1:
		return 5 * time.Second
	case 2:
		return 10 * time.Second
	case 3:
		return 30 * time.Second
	default:
		return time.Minute
	}
}

func unknownCodexPluginInventoryRecords() []codexPluginInventoryRecord {
	return []codexPluginInventoryRecord{
		{option: ComposerPluginOption{ID: "codex-native:browser", Name: "browser", Label: "Browser", Semantic: "browserUse", Status: ComposerPluginStatusUnknown}},
		{option: ComposerPluginOption{ID: "codex-native:computer", Name: "computer", Label: "Computer Use", Semantic: "computerUse", Status: ComposerPluginStatusUnknown}},
		{option: ComposerPluginOption{ID: "codex-native:sites", Name: "sites", Label: "Sites", Semantic: "sites", Status: ComposerPluginStatusUnknown}},
	}
}

func mergeUnknownCodexPluginInventoryRecords(
	records []codexPluginInventoryRecord,
) []codexPluginInventoryRecord {
	bySemantic := map[string]codexPluginInventoryRecord{}
	for _, record := range records {
		bySemantic[record.option.Semantic] = record
	}
	result := make([]codexPluginInventoryRecord, 0, 3)
	for _, fallback := range unknownCodexPluginInventoryRecords() {
		if record, ok := bySemantic[fallback.option.Semantic]; ok {
			result = append(result, record)
		} else {
			result = append(result, fallback)
		}
	}
	return result
}

func (l codexAppServerPluginInventoryLister) ListPluginInventory(
	ctx context.Context,
	cwd string,
) codexPluginInventoryResult {
	command := strings.TrimSpace(l.command)
	if command == "" {
		return codexPluginInventoryResult{errors: []string{"plugin inventory command is required"}}
	}
	resolver := runtimecmd.Resolver{}
	processEnv := resolver.Env(nil)
	command = resolver.Resolve(command, processEnv)
	timeout := l.processTimeout()
	processCtx, cancel := context.WithTimeout(ctx, timeout)
	process, err := startCodexAppServerProcess(processCtx, command, append([]string(nil), l.args...), processEnv)
	if err != nil {
		cancel()
		return codexPluginInventoryResult{errors: []string{err.Error()}}
	}
	result := requestCodexPluginInventoryWithContext(processCtx, process.stdin, process.stdout, cwd)
	processErr := processCtx.Err()
	stopErr := process.stop(cancel)
	if processErr != nil {
		result.errors = append(result.errors, "plugin inventory timed out")
	}
	if stderr := strings.TrimSpace(process.stderr.String()); stderr != "" {
		result.diagnostics = append(result.diagnostics, "codex app-server stderr: "+stderr)
	}
	if stopErr != nil && processErr == nil {
		result.diagnostics = append(result.diagnostics, "stop codex app-server: "+stopErr.Error())
	}
	return result
}

func (l codexAppServerPluginInventoryLister) processTimeout() time.Duration {
	if l.timeout <= 0 || l.timeout > codexPluginInventoryTimeout {
		return codexPluginInventoryTimeout
	}
	return l.timeout
}

func requestCodexPluginInventory(
	stdin io.Writer,
	stdout io.Reader,
	cwd string,
) codexPluginInventoryResult {
	return requestCodexPluginInventoryWithContext(context.Background(), stdin, stdout, cwd)
}

type codexPluginInventoryResponseStream struct {
	responses <-chan map[string]json.RawMessage
	done      <-chan error
}

func newCodexPluginInventoryResponseStream(
	ctx context.Context,
	stdout io.Reader,
) codexPluginInventoryResponseStream {
	responses := make(chan map[string]json.RawMessage, 16)
	done := make(chan error, 1)
	go func() {
		defer close(responses)
		scanner := bufio.NewScanner(stdout)
		scanner.Buffer(make([]byte, 0, 64*1024), codexModelListMaxLineBytes)
		for scanner.Scan() {
			var response map[string]json.RawMessage
			if json.Unmarshal(scanner.Bytes(), &response) != nil {
				continue
			}
			select {
			case responses <- response:
			case <-ctx.Done():
				done <- ctx.Err()
				return
			}
		}
		done <- scanner.Err()
	}()
	return codexPluginInventoryResponseStream{responses: responses, done: done}
}

func (stream codexPluginInventoryResponseStream) next(
	ctx context.Context,
) (map[string]json.RawMessage, error) {
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case response, ok := <-stream.responses:
		if ok {
			return response, nil
		}
		// The producer writes its terminal scanner error before closing
		// responses. Consume it once when available, but make every later EOF
		// read stable instead of blocking on an already-drained channel.
		select {
		case err, ok := <-stream.done:
			if ok && err != nil {
				return nil, err
			}
		default:
		}
		return nil, io.EOF
	}
}

func waitCodexPluginInventoryResponse(
	ctx context.Context,
	stream codexPluginInventoryResponseStream,
	requestID string,
) (map[string]json.RawMessage, error) {
	for {
		response, err := stream.next(ctx)
		if err != nil {
			return nil, err
		}
		if codexRPCIDString(response["id"]) == requestID {
			return response, nil
		}
	}
}

func requestCodexPluginInventoryWithContext(
	ctx context.Context,
	stdin io.Writer,
	stdout io.Reader,
	cwd string,
) codexPluginInventoryResult {
	encoder := json.NewEncoder(stdin)
	stream := newCodexPluginInventoryResponseStream(ctx, stdout)
	if err := encoder.Encode(map[string]any{
		"id": "1", "method": "initialize",
		"params": map[string]any{
			"clientInfo":   map[string]string{"name": "tuttid", "version": "0.1.0"},
			"capabilities": map[string]any{"experimentalApi": true},
		},
	}); err != nil {
		return codexPluginInventoryResult{errors: []string{err.Error()}}
	}
	initialize, err := waitCodexPluginInventoryResponse(ctx, stream, "1")
	if err != nil {
		return codexPluginInventoryResult{errors: []string{fmt.Sprintf("read initialize response: %v", err)}}
	}
	if rawError := initialize["error"]; len(rawError) > 0 && string(rawError) != "null" {
		return codexPluginInventoryResult{errors: []string{"initialize failed"}}
	}
	if err := encoder.Encode(map[string]any{"method": "initialized", "params": map[string]any{}}); err != nil {
		return codexPluginInventoryResult{errors: []string{err.Error()}}
	}
	cwds := []string{}
	if cwd != "" {
		cwds = append(cwds, cwd)
	}
	if err := encoder.Encode(map[string]any{
		"id": "plugin-list", "method": "plugin/list", "params": map[string]any{"cwds": cwds},
	}); err != nil {
		return codexPluginInventoryResult{errors: []string{err.Error()}}
	}
	response, err := waitCodexPluginInventoryResponse(ctx, stream, "plugin-list")
	if err != nil {
		return codexPluginInventoryResult{errors: []string{fmt.Sprintf("read plugin/list response: %v", err)}}
	}
	if rawError := response["error"]; len(rawError) > 0 && string(rawError) != "null" {
		return codexPluginInventoryResult{errors: []string{"plugin/list failed"}}
	}
	records, parseErrors := parseCodexPluginInventory(response["result"])
	result := codexPluginInventoryResult{records: records, errors: parseErrors}
	pendingReads := make(map[string]*codexPluginInventoryRecord)
	for index := range result.records {
		if !eligibleCodexPluginRead(result.records[index]) {
			continue
		}
		requestID := fmt.Sprintf("plugin-read-%d", index)
		params := map[string]any{"pluginName": result.records[index].pluginName}
		if result.records[index].marketplaceIsRemote {
			params["remoteMarketplaceName"] = result.records[index].remoteMarketplaceName
		} else {
			params["marketplacePath"] = result.records[index].marketplacePath
		}
		if err := encoder.Encode(map[string]any{
			"id": requestID, "method": "plugin/read",
			"params": params,
		}); err != nil {
			// A read only proves optional Slash suppression. Do not poison the
			// verified inventory when one individual request cannot be sent.
			result.diagnostics = append(result.diagnostics, "plugin/read write failed")
			continue
		}
		pendingReads[requestID] = &result.records[index]
	}
	// Send every eligible request before waiting for any response. App Server
	// responses may arrive out of order; request IDs isolate each optional
	// proof. A bounded read window means one missing response does not delay
	// other completed mappings until the full process timeout.
	readCtx, cancelReads := context.WithTimeout(ctx, codexPluginInventoryReadTimeout)
	defer cancelReads()
	for len(pendingReads) > 0 {
		readResponse, err := stream.next(readCtx)
		if err != nil {
			break
		}
		requestID := codexRPCIDString(readResponse["id"])
		record, ok := pendingReads[requestID]
		if !ok {
			continue
		}
		delete(pendingReads, requestID)
		applyCodexPluginInventoryReadResponse(readResponse, record)
	}
	if len(pendingReads) > 0 {
		result.diagnostics = append(result.diagnostics, "one or more plugin/read responses were missing")
	}
	return result
}

func applyCodexPluginInventoryReadResponse(
	response map[string]json.RawMessage,
	record *codexPluginInventoryRecord,
) {
	if record == nil {
		return
	}
	if rawError := response["error"]; len(rawError) > 0 && string(rawError) != "null" {
		return
	}
	if record.marketplaceIsRemote {
		// Remote plugin metadata has no canonical local source root. It can
		// enrich inventory diagnostics, but it can never establish a display
		// hide mapping, so it deliberately leaves BundledSkills empty.
		return
	}
	skills, ok := verifyCodexPluginReadMapping(response["result"], *record)
	if !ok {
		return
	}
	record.option.BundledSkills = skills
}
