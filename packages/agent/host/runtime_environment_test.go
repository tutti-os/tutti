package agenthost

import (
	"reflect"
	"strings"
	"testing"

	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
)

func TestAgentRailPlacementEnvironmentSuppliesCanonicalValuesLast(t *testing.T) {
	env, err := withAgentRailPlacementEnvironment([]string{
		"KEEP=value",
		AgentCWDEnvironmentVariable + "=/stale",
		"tutti_agent_cwd=/case-distinct-cwd",
		AgentRailPlacementEnvironmentVariable + "={\"version\":1,\"kind\":\"conversations\",\"sectionKey\":\"conversations\"}",
		"tutti_agent_rail_placement=case-distinct-placement",
		AgentRailPlacementEnvironmentVariable + "=duplicate",
		"TAIL=value",
	}, "/workspace/app/pkg", &RailPlacement{
		Version: 1, Kind: RailPlacementKindProject, ProjectPath: "/workspace/app",
		SectionKey: "project:/ignored",
	})
	if err != nil {
		t.Fatalf("withAgentRailPlacementEnvironment() error = %v", err)
	}
	if got := countEnvironmentKey(env, AgentCWDEnvironmentVariable); got != 1 {
		t.Fatalf("cwd environment count = %d, env=%#v", got, env)
	}
	if got := countEnvironmentKey(env, AgentRailPlacementEnvironmentVariable); got != 1 {
		t.Fatalf("rail environment count = %d, env=%#v", got, env)
	}
	cwd, _ := testEnvironmentValue(env, AgentCWDEnvironmentVariable)
	if cwd != "/workspace/app/pkg" {
		t.Fatalf("cwd environment = %q", cwd)
	}
	encoded, _ := testEnvironmentValue(env, AgentRailPlacementEnvironmentVariable)
	placement, err := ParseAgentRailPlacementEnvironment(encoded)
	if err != nil {
		t.Fatalf("ParseAgentRailPlacementEnvironment() error = %v", err)
	}
	if placement.Kind != RailPlacementKindProject ||
		placement.ProjectPath != storesqlite.NormalizeProjectPath("/workspace/app") ||
		placement.SectionKey != storesqlite.RailSectionKeyForProject("/workspace/app") {
		t.Fatalf("parsed placement = %#v", placement)
	}
	if keep, _ := testEnvironmentValue(env, "KEEP"); keep != "value" {
		t.Fatalf("unrelated environment was not preserved: %#v", env)
	}
	want := []string{
		"KEEP=value",
		"tutti_agent_cwd=/case-distinct-cwd",
		"tutti_agent_rail_placement=case-distinct-placement",
		"TAIL=value",
		AgentCWDEnvironmentVariable + "=/workspace/app/pkg",
		AgentRailPlacementEnvironmentVariable + "=" + encoded,
	}
	if !reflect.DeepEqual(env, want) {
		t.Fatalf("environment = %#v, want canonical values last after %#v", env, want)
	}
}

func TestParseAgentRailPlacementEnvironmentRejectsUntrustedShapes(t *testing.T) {
	for _, value := range []string{
		"",
		`{"version":2,"kind":"conversations","sectionKey":"conversations"}`,
		`{"version":1,"kind":"conversations","sectionKey":"conversations","unknown":true}`,
		`{"version":1,"kind":"conversations","sectionKey":"conversations"} {}`,
	} {
		if placement, err := ParseAgentRailPlacementEnvironment(value); err == nil {
			t.Fatalf("ParseAgentRailPlacementEnvironment(%q) = %#v, want error", value, placement)
		}
	}
}

func countEnvironmentKey(env []string, key string) int {
	count := 0
	for _, entry := range env {
		if strings.HasPrefix(entry, key+"=") {
			count++
		}
	}
	return count
}

func testEnvironmentValue(env []string, key string) (string, bool) {
	prefix := key + "="
	for _, entry := range env {
		if strings.HasPrefix(entry, prefix) {
			return strings.TrimPrefix(entry, prefix), true
		}
	}
	return "", false
}
