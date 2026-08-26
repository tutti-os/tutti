package main

import (
	"testing"

	agentservice "github.com/tutti-os/tutti/services/tuttid/service/agent"
	eventstreamservice "github.com/tutti-os/tutti/services/tuttid/service/eventstream"
)

type recordingAgentAuthInvalidationSessions struct {
	liveModels         []string
	runtimeCredentials []string
}

func (s *recordingAgentAuthInvalidationSessions) InvalidateLiveComposerModels(provider string) {
	s.liveModels = append(s.liveModels, provider)
}

func (s *recordingAgentAuthInvalidationSessions) InvalidateProviderRuntimeCredentials(
	provider string,
) {
	s.runtimeCredentials = append(s.runtimeCredentials, provider)
}

func (*recordingAgentAuthInvalidationSessions) SetLiveModelCatalogUpdated(func(string)) {}

func TestStartAgentModelInvalidationAuthWatcherInvalidatesRuntimeCredentials(t *testing.T) {
	sessions := &recordingAgentAuthInvalidationSessions{}
	watcher := startAgentModelInvalidationAuthWatcher(
		false,
		&agentservice.CachedAgentModelCatalog{},
		sessions,
		eventstreamservice.NewService(eventstreamservice.DefaultCatalog(), nil),
	)
	if watcher == nil {
		t.Fatal("startAgentModelInvalidationAuthWatcher returned nil")
	}
	defer watcher.Close()

	watcher.OnChangeDetailed([]agentservice.ProviderAuthChange{{
		Provider: "cursor",
		Path:     `C:\Users\tester\.cursor\cli-config.json`,
		Kind:     "content_changed",
	}})

	if got, want := sessions.liveModels, []string{"cursor"}; !equalStrings(got, want) {
		t.Fatalf("live model invalidations = %v, want %v", got, want)
	}
	if got, want := sessions.runtimeCredentials, []string{"cursor"}; !equalStrings(got, want) {
		t.Fatalf("runtime credential invalidations = %v, want %v", got, want)
	}
}

func equalStrings(got, want []string) bool {
	if len(got) != len(want) {
		return false
	}
	for i := range got {
		if got[i] != want[i] {
			return false
		}
	}
	return true
}
