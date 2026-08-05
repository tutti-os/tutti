package api

import (
	"context"
	"errors"
	"testing"

	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
	agentservice "github.com/tutti-os/tutti/services/tuttid/service/agent"
)

func TestListAgentProviderPluginsRequiresBody(t *testing.T) {
	response, err := (DaemonAPI{AgentSessionService: stubAgentSessionService{}}).ListAgentProviderPlugins(
		context.Background(),
		tuttigenerated.ListAgentProviderPluginsRequestObject{Provider: "codex"},
	)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := response.(tuttigenerated.ListAgentProviderPlugins400JSONResponse); !ok {
		t.Fatalf("response = %T, want 400", response)
	}
}

func TestListAgentProviderPluginsClassifiesServiceErrors(t *testing.T) {
	targetID := "target-1"
	request := tuttigenerated.ListAgentProviderPluginsRequestObject{
		Provider: "codex",
		Body:     &tuttigenerated.ListAgentProviderPluginsRequest{AgentTargetId: targetID, Prime: boolPointer(true)},
	}
	for name, testCase := range map[string]struct {
		err      error
		response any
	}{
		"target missing": {agentservice.ErrComposerPluginInventoryTargetNotFound, tuttigenerated.ListAgentProviderPlugins404JSONResponse{}},
		"unavailable":    {agentservice.ErrComposerPluginInventoryUnavailable, tuttigenerated.ListAgentProviderPlugins503JSONResponse{}},
		"invalid":        {agentservice.ErrInvalidArgument, tuttigenerated.ListAgentProviderPlugins400JSONResponse{}},
		"upstream":       {errors.New("store failed"), tuttigenerated.ListAgentProviderPlugins502JSONResponse{}},
	} {
		t.Run(name, func(t *testing.T) {
			response, err := (DaemonAPI{AgentSessionService: stubAgentSessionService{
				primeComposerPluginInventoryFn: func(context.Context, agentservice.ComposerPluginOptionsInput) error {
					return testCase.err
				},
			}}).ListAgentProviderPlugins(context.Background(), request)
			if err != nil {
				t.Fatal(err)
			}
			switch testCase.response.(type) {
			case tuttigenerated.ListAgentProviderPlugins400JSONResponse:
				if _, ok := response.(tuttigenerated.ListAgentProviderPlugins400JSONResponse); !ok {
					t.Fatalf("response = %T, want 400", response)
				}
			case tuttigenerated.ListAgentProviderPlugins404JSONResponse:
				if _, ok := response.(tuttigenerated.ListAgentProviderPlugins404JSONResponse); !ok {
					t.Fatalf("response = %T, want 404", response)
				}
			case tuttigenerated.ListAgentProviderPlugins502JSONResponse:
				if _, ok := response.(tuttigenerated.ListAgentProviderPlugins502JSONResponse); !ok {
					t.Fatalf("response = %T, want 502", response)
				}
			case tuttigenerated.ListAgentProviderPlugins503JSONResponse:
				if _, ok := response.(tuttigenerated.ListAgentProviderPlugins503JSONResponse); !ok {
					t.Fatalf("response = %T, want 503", response)
				}
			}
		})
	}
}

func TestListAgentProviderPluginsMapsSnapshotWithoutPrimingWhenPrimeIsFalse(t *testing.T) {
	targetID := "local:codex"
	cwd := "/workspace"
	prime := false
	primed := false
	response, err := (DaemonAPI{AgentSessionService: stubAgentSessionService{
		primeComposerPluginInventoryFn: func(context.Context, agentservice.ComposerPluginOptionsInput) error {
			primed = true
			return nil
		},
		composerPluginOptionsFn: func(_ context.Context, input agentservice.ComposerPluginOptionsInput) (agentservice.ComposerPluginOptions, error) {
			if input.Provider != "codex" || input.AgentTargetID != targetID || input.Cwd != cwd {
				t.Fatalf("input = %#v", input)
			}
			return agentservice.ComposerPluginOptions{
				Provider: "codex",
				Plugins: []agentservice.ComposerPluginOption{{
					ID:            "plugin:sites@openai-bundled",
					Name:          "sites",
					Label:         "Sites",
					Description:   "Build sites",
					Semantic:      "sites",
					Status:        agentservice.ComposerPluginStatusReady,
					BundledSkills: []agentservice.ComposerPluginBundledSkill{{Name: "sites:sites-building", Path: "/plugin/skills/sites/SKILL.md"}},
				}},
			}, nil
		},
	}}).ListAgentProviderPlugins(context.Background(), tuttigenerated.ListAgentProviderPluginsRequestObject{
		Provider: "codex",
		Body:     &tuttigenerated.ListAgentProviderPluginsRequest{AgentTargetId: targetID, Cwd: &cwd, Prime: &prime},
	})
	if err != nil {
		t.Fatal(err)
	}
	if primed {
		t.Fatal("prime=false must not start inventory refresh")
	}
	snapshot, ok := response.(tuttigenerated.ListAgentProviderPlugins200JSONResponse)
	if !ok {
		t.Fatalf("response = %T, want 200", response)
	}
	if snapshot.Provider != "codex" || snapshot.Partial || len(snapshot.Plugins) != 1 ||
		snapshot.Plugins[0].Semantic != "sites" || snapshot.Plugins[0].BundledSkills == nil ||
		len(*snapshot.Plugins[0].BundledSkills) != 1 {
		t.Fatalf("snapshot = %#v", snapshot)
	}
}
