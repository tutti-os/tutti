package agentruntime

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"strings"
	"sync"
	"time"
)

const codexAppServerResourceQueryTimeout = 5 * time.Second
const codexAppServerResourceProbeDelay = 100 * time.Millisecond

// observeStartupResourcesAsync deliberately starts before thread/start or
// thread/resume. The short scheduling delay lets the startup call acquire the
// app-server client's serialized RPC lock first; a blocked startup call then
// causes these bounded probes to time out without delaying provider startup.
func (a *CodexAppServerAdapter) observeStartupResourcesAsync(
	session Session,
	client *codexAppServerClient,
	trace *codexAppServerStartupTrace,
) {
	if a == nil || a.startupResourceObserver == nil || client == nil || trace == nil {
		return
	}
	observer := a.startupResourceObserver
	startedAt := trace.startedAt.UTC().Format(time.RFC3339Nano)
	go func() {
		timer := time.NewTimer(codexAppServerResourceProbeDelay)
		defer timer.Stop()
		select {
		case <-timer.C:
		case <-client.Done():
		}
		observation := collectCodexAppServerResourceObservation(
			context.Background(),
			session,
			client,
			startedAt,
		)
		trace.Log("startup.resource_snapshot", map[string]any{
			"outcome":              observation.Outcome,
			"duration_ms":          observation.DurationMS,
			"mcp_server_count":     observation.MCPServerCount,
			"plugin_count":         observation.PluginCount,
			"skill_count":          observation.SkillCount,
			"plugin_query_outcome": observation.PluginQueryOutcome,
			"skill_query_outcome":  observation.SkillQueryOutcome,
		})
		notifyCodexAppServerResourceObserver(observer, observation)
	}()
}

func collectCodexAppServerResourceObservation(
	parent context.Context,
	session Session,
	client *codexAppServerClient,
	startedAt string,
) CodexAppServerResourceObservation {
	started := time.Now()
	observation := CodexAppServerResourceObservation{
		Provider:           strings.TrimSpace(session.Provider),
		RoomID:             strings.TrimSpace(session.RoomID),
		AgentSessionID:     strings.TrimSpace(session.AgentSessionID),
		StartedAt:          strings.TrimSpace(startedAt),
		Outcome:            "failed",
		MCPServerCount:     len(session.MCPServers),
		PluginCount:        -1,
		SkillCount:         -1,
		PluginQueryOutcome: "not_started",
		SkillQueryOutcome:  "not_started",
	}
	if client == nil {
		observation.DurationMS = time.Since(started).Milliseconds()
		return observation
	}
	ctx, cancel := context.WithTimeout(parent, codexAppServerResourceQueryTimeout)
	defer cancel()

	var wg sync.WaitGroup
	var pluginRaw, skillRaw json.RawMessage
	var pluginErr, skillErr error
	params := map[string]any{}
	if cwd := strings.TrimSpace(session.CWD); cwd != "" {
		params["cwds"] = []string{cwd}
	}
	wg.Add(2)
	go func() {
		defer wg.Done()
		pluginRaw, pluginErr = client.PluginList(ctx, codexAppServerResourceQueryTimeout, params)
	}()
	go func() {
		defer wg.Done()
		skillRaw, skillErr = client.SkillsList(ctx, codexAppServerResourceQueryTimeout, params)
	}()
	wg.Wait()

	if pluginErr == nil {
		if count, ok := countCodexAppServerPlugins(pluginRaw); ok {
			observation.PluginCount = count
			observation.PluginQueryOutcome = "succeeded"
		} else {
			observation.PluginQueryOutcome = "decode_failed"
		}
	} else {
		observation.PluginQueryOutcome = codexAppServerResourceQueryOutcome(ctx, pluginErr)
	}
	if skillErr == nil {
		if count, ok := countCodexAppServerSkills(skillRaw); ok {
			observation.SkillCount = count
			observation.SkillQueryOutcome = "succeeded"
		} else {
			observation.SkillQueryOutcome = "decode_failed"
		}
	} else {
		observation.SkillQueryOutcome = codexAppServerResourceQueryOutcome(ctx, skillErr)
	}
	if observation.PluginQueryOutcome == "succeeded" && observation.SkillQueryOutcome == "succeeded" {
		observation.Outcome = "succeeded"
	} else if observation.PluginQueryOutcome == "succeeded" || observation.SkillQueryOutcome == "succeeded" {
		observation.Outcome = "partial"
	}
	observation.DurationMS = time.Since(started).Milliseconds()
	return observation
}

func codexAppServerResourceQueryOutcome(ctx context.Context, err error) string {
	if err == nil {
		return "succeeded"
	}
	if errors.Is(err, context.DeadlineExceeded) || errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return "timeout"
	}
	return "failed"
}

func countCodexAppServerPlugins(raw json.RawMessage) (int, bool) {
	var envelope map[string]json.RawMessage
	if len(raw) == 0 || json.Unmarshal(raw, &envelope) != nil {
		return 0, false
	}
	marketplacesRaw, ok := envelope["marketplaces"]
	var marketplaces []json.RawMessage
	if !ok || json.Unmarshal(marketplacesRaw, &marketplaces) != nil || marketplaces == nil {
		return 0, false
	}
	var response struct {
		Marketplaces []struct {
			Name    string `json:"name"`
			Plugins []struct {
				ID        string `json:"id"`
				Name      string `json:"name"`
				Installed bool   `json:"installed"`
				Enabled   bool   `json:"enabled"`
			} `json:"plugins"`
		} `json:"marketplaces"`
	}
	if json.Unmarshal(raw, &response) != nil {
		return 0, false
	}
	seen := make(map[string]struct{})
	for _, marketplace := range response.Marketplaces {
		for _, plugin := range marketplace.Plugins {
			if !plugin.Installed || !plugin.Enabled {
				continue
			}
			key := strings.TrimSpace(plugin.ID)
			if key == "" {
				key = strings.TrimSpace(marketplace.Name) + "\x00" + strings.TrimSpace(plugin.Name)
			}
			if key != "\x00" {
				seen[key] = struct{}{}
			}
		}
	}
	return len(seen), true
}

func countCodexAppServerSkills(raw json.RawMessage) (int, bool) {
	var envelope map[string]json.RawMessage
	if len(raw) == 0 || json.Unmarshal(raw, &envelope) != nil {
		return 0, false
	}
	dataRaw, ok := envelope["data"]
	var data []json.RawMessage
	if !ok || json.Unmarshal(dataRaw, &data) != nil || data == nil {
		return 0, false
	}
	var response struct {
		Data []struct {
			Skills []struct {
				Name    string `json:"name"`
				Path    string `json:"path"`
				Enabled *bool  `json:"enabled"`
			} `json:"skills"`
		} `json:"data"`
	}
	if json.Unmarshal(raw, &response) != nil {
		return 0, false
	}
	seen := make(map[string]struct{})
	for _, group := range response.Data {
		for _, skill := range group.Skills {
			if skill.Enabled != nil && !*skill.Enabled {
				continue
			}
			name := strings.TrimSpace(skill.Name)
			path := strings.TrimSpace(skill.Path)
			key := path
			if key == "" {
				key = name
			}
			if key != "" {
				seen[key] = struct{}{}
			}
		}
	}
	return len(seen), true
}

func notifyCodexAppServerResourceObserver(
	observer CodexAppServerResourceObserver,
	observation CodexAppServerResourceObservation,
) {
	if observer == nil {
		return
	}
	defer func() {
		if recovered := recover(); recovered != nil {
			slog.Warn("agent session Codex app-server resource observer panicked",
				"provider", observation.Provider,
				"agent_session_id", observation.AgentSessionID,
				"panic", recovered,
			)
		}
	}()
	observer(observation)
}
