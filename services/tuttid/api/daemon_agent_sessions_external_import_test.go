package api

import (
	"context"
	"testing"

	userprojectbiz "github.com/tutti-os/tutti/services/tuttid/biz/userproject"
	agentservice "github.com/tutti-os/tutti/services/tuttid/service/agent"
	userprojectservice "github.com/tutti-os/tutti/services/tuttid/service/userproject"
)

func TestRegisterExternalImportUserProjectsPreservesInputOrderInLastUsedTimes(t *testing.T) {
	var inputs []userprojectservice.UseInput
	api := DaemonAPI{
		UserProjectService: stubUserProjectService{
			useFn: func(_ context.Context, input userprojectservice.UseInput) (userprojectbiz.Project, error) {
				inputs = append(inputs, input)
				return userprojectbiz.Project{Path: input.Path}, nil
			},
		},
	}

	registered, errors := api.registerExternalImportUserProjects(context.Background(), []agentservice.ExternalImportProjectSelection{
		{Path: "/workspace/newer"},
		{Path: "/workspace/older"},
	}, true)
	if len(errors) != 0 {
		t.Fatalf("registration errors = %#v, want none", errors)
	}
	if len(registered) != 2 || len(inputs) != 2 {
		t.Fatalf("registered = %#v inputs = %#v, want two projects", registered, inputs)
	}
	if inputs[0].LastUsedAtUnixMS <= inputs[1].LastUsedAtUnixMS {
		t.Fatalf("last used times = [%d, %d], want first input newer", inputs[0].LastUsedAtUnixMS, inputs[1].LastUsedAtUnixMS)
	}
}
