package conformance

import (
	"slices"
	"testing"
)

func TestPublishedScenarioCatalogsHaveUniqueNames(t *testing.T) {
	t.Parallel()
	catalogs := []struct {
		name      string
		scenarios []Scenario
		wantCount int
	}{
		{name: "adapter lifecycle", scenarios: Scenarios(), wantCount: 17},
		{name: "application core", scenarios: ApplicationCoreScenarios(), wantCount: 12},
		{name: "resume policy", scenarios: ResumePolicyScenarios(), wantCount: 4},
		{name: "submission fence", scenarios: SubmissionFenceScenarios(), wantCount: 1},
		{name: "title policy", scenarios: TitlePolicyScenarios(), wantCount: 1},
		{name: "coordinator", scenarios: CoordinatorScenarios(), wantCount: 7},
		{name: "goal", scenarios: GoalScenarios(), wantCount: 7},
		{name: "commit observer", scenarios: CommitObserverScenarios(), wantCount: 2},
	}
	for _, catalog := range catalogs {
		catalog := catalog
		t.Run(catalog.name, func(t *testing.T) {
			t.Parallel()
			seen := map[string]struct{}{}
			for _, scenario := range catalog.scenarios {
				if scenario.Name == "" {
					t.Fatal("conformance scenario has an empty name")
				}
				if _, ok := seen[scenario.Name]; ok {
					t.Fatalf("duplicate conformance scenario name %q", scenario.Name)
				}
				seen[scenario.Name] = struct{}{}
			}
			if len(seen) != catalog.wantCount {
				t.Fatalf("scenario count=%d, want %d", len(seen), catalog.wantCount)
			}
		})
	}
}

func TestScenarioOwnershipIsExplicit(t *testing.T) {
	t.Parallel()
	wantApplicationCore := []string{
		"create empty session",
		"create with initial content",
		"resume persisted session",
		"send input",
		"duplicate client submit id",
		"initial title cas",
		"get session",
		"historical and live settings",
		"pin session",
		"delete session",
		"delete live session before canonical report",
		"purge deleted sessions",
	}
	wantCoordinator := []string{
		"exact turn cancel",
		"interactive response",
		"interactive response reuses provider request id across turns",
		"interactive response race",
		"plan decision",
		"recover operations before stale turns and worktree sweep",
		"worktree sweep failure propagates",
	}
	if got := scenarioNames(ApplicationCoreScenarios()); !slices.Equal(got, wantApplicationCore) {
		t.Fatalf("application core scenarios=%v, want %v", got, wantApplicationCore)
	}
	if got := scenarioNames(CoordinatorScenarios()); !slices.Equal(got, wantCoordinator) {
		t.Fatalf("coordinator scenarios=%v, want %v", got, wantCoordinator)
	}
}

func scenarioNames(scenarios []Scenario) []string {
	names := make([]string, 0, len(scenarios))
	for _, scenario := range scenarios {
		names = append(names, scenario.Name)
	}
	return names
}
