package agentstatus

import (
	"context"
	"crypto/sha256"
	"fmt"
	"strings"
	"sync"
	"time"

	"golang.org/x/sync/singleflight"
)

const defaultProviderStatusCacheTTL = 30 * time.Minute

// ProviderStatusCache is the daemon-owned application cache for local provider
// readiness. Entries are keyed by provider rather than request shape so a
// whole-catalog probe also satisfies a later single-provider lookup.
type ProviderStatusCache struct {
	mu      sync.RWMutex
	entries map[string]providerStatusCacheEntry
	group   singleflight.Group
}

type providerStatusCacheEntry struct {
	cachedAt              time.Time
	credentialFingerprint string
	runtimeFingerprint    string
	status                ProviderStatus
}

func NewProviderStatusCache() *ProviderStatusCache {
	return &ProviderStatusCache{entries: make(map[string]providerStatusCacheEntry)}
}

func (c *ProviderStatusCache) get(provider string, now time.Time, ttl time.Duration) (ProviderStatus, time.Time, string, string, bool) {
	if c == nil || ttl <= 0 {
		return ProviderStatus{}, time.Time{}, "", "", false
	}
	c.mu.RLock()
	entry, ok := c.entries[provider]
	c.mu.RUnlock()
	if !ok || now.Sub(entry.cachedAt) > ttl {
		return ProviderStatus{}, time.Time{}, "", "", false
	}
	return cloneProviderStatus(entry.status), entry.cachedAt, entry.credentialFingerprint, entry.runtimeFingerprint, true
}

func (c *ProviderStatusCache) set(provider string, cachedAt time.Time, credentialFingerprint, runtimeFingerprint string, status ProviderStatus) {
	if c == nil {
		return
	}
	c.mu.Lock()
	c.entries[provider] = providerStatusCacheEntry{
		cachedAt:              cachedAt,
		credentialFingerprint: credentialFingerprint,
		runtimeFingerprint:    runtimeFingerprint,
		status:                cloneProviderStatus(status),
	}
	c.mu.Unlock()
}

// providerRuntimeFingerprint is intentionally opaque: it notices a changed
// resolved launcher, real executable, command, or effective app-server
// environment without storing environment values (which may contain secrets)
// in the status cache or logs.
func (s Service) providerRuntimeFingerprint(ctx context.Context, spec ProviderSpec) string {
	runtimeResolution := s.resolveProviderRuntime(ctx, spec)
	command := runtimeResolution.AdapterCommand
	if len(command) == 0 {
		command = spec.AdapterCommand
	}
	env := s.commandResolver().Env(s.adapterCommandEnv(ctx, spec))
	parts := []string{
		spec.Provider,
		providerRuntimeBinaryFingerprint(runtimeResolution.CLIPath),
		providerRuntimeBinaryFingerprint(runtimeResolution.AdapterPath),
		strings.Join(command, "\x00"),
		strings.Join(env, "\x00"),
	}
	sum := sha256.Sum256([]byte(strings.Join(parts, "\x00")))
	return fmt.Sprintf("%x", sum[:])
}

func providerRuntimeBinaryFingerprint(path string) string {
	fingerprint, ok := readExecutableFingerprint(path)
	if !ok {
		return "missing:" + strings.TrimSpace(path)
	}
	return fingerprint.resolvedPath + "\x00" +
		fmt.Sprintf("%d\x00%d", fingerprint.info.Size(), fingerprint.info.ModTime().UnixNano())
}

func (c *ProviderStatusCache) invalidate(provider string) {
	if c == nil {
		return
	}
	c.mu.Lock()
	delete(c.entries, provider)
	c.mu.Unlock()
}

func (s Service) providerCredentialFingerprint(spec ProviderSpec) string {
	paths, complete := s.resolvedAuthMarkerPaths(spec)
	if len(paths) == 0 {
		if !complete {
			return "markers:unavailable"
		}
		return ""
	}
	parts := make([]string, 0, len(paths)+1)
	if !complete {
		parts = append(parts, "markers:incomplete")
	}
	for _, path := range paths {
		if modifiedAt, ok := s.fileModTime(path); ok {
			parts = append(parts, path+"="+modifiedAt.UTC().Format(time.RFC3339Nano))
			continue
		}
		if s.fileExists(path) {
			parts = append(parts, path+"=present")
			continue
		}
		parts = append(parts, path+"=missing")
	}
	return strings.Join(parts, "\x00")
}

func cloneProviderStatus(status ProviderStatus) ProviderStatus {
	result := status
	if status.Availability.CheckedAt != nil {
		checkedAt := *status.Availability.CheckedAt
		result.Availability.CheckedAt = &checkedAt
	}
	result.Adapter.Command = cloneStrings(status.Adapter.Command)
	if len(status.Actions) > 0 {
		result.Actions = make([]Action, len(status.Actions))
		for i, action := range status.Actions {
			result.Actions[i] = action
			if action.Command != nil {
				command := *action.Command
				result.Actions[i].Command = &command
			}
		}
	}
	result.Checks = append([]ProviderCheck(nil), status.Checks...)
	if status.LastError != nil {
		lastError := *status.LastError
		result.LastError = &lastError
	}
	if status.ActiveAction != nil {
		activeAction := *status.ActiveAction
		result.ActiveAction = &activeAction
	}
	if status.CodexDiagnostics != nil {
		copy := *status.CodexDiagnostics
		copy.Checks = append([]CodexDiagnosticCheck(nil), status.CodexDiagnostics.Checks...)
		copy.Diagnosis.SecondaryDiagnosticCodes = append([]string(nil), status.CodexDiagnostics.Diagnosis.SecondaryDiagnosticCodes...)
		copy.RepairPlan.SupportingEvidence = append([]string(nil), status.CodexDiagnostics.RepairPlan.SupportingEvidence...)
		result.CodexDiagnostics = &copy
	}
	return result
}
