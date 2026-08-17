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
		{name: "adapter lifecycle", scenarios: Scenarios(), wantCount: 34},
		{name: "application core", scenarios: ApplicationCoreScenarios(), wantCount: 29},
		{name: "guidance", scenarios: GuidanceScenarios(), wantCount: 3},
		{name: "resume policy", scenarios: ResumePolicyScenarios(), wantCount: 5},
		{name: "submission fence", scenarios: SubmissionFenceScenarios(), wantCount: 1},
		{name: "title policy", scenarios: TitlePolicyScenarios(), wantCount: 1},
		{name: "deletion admission", scenarios: DeletionAdmissionScenarios(), wantCount: 3},
		{name: "coordinator", scenarios: CoordinatorScenarios(), wantCount: 7},
		{name: "goal", scenarios: GoalScenarios(), wantCount: 17},
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

func TestPublishedWorkspaceRuntimeDisconnectScenarioCatalogHasUniqueNames(t *testing.T) {
	t.Parallel()
	scenarios := WorkspaceRuntimeDisconnectScenarios()
	if len(scenarios) != 1 || scenarios[0].Name == "" {
		t.Fatalf("workspace runtime disconnect scenarios=%#v", scenarios)
	}
}

func TestPublishedWorkspaceRuntimeAdmissionScenarioCatalogHasUniqueNames(t *testing.T) {
	scenarios := WorkspaceRuntimeAdmissionScenarios()
	seen := make(map[string]struct{}, len(scenarios))
	for _, scenario := range scenarios {
		if scenario.Name == "" {
			t.Fatal("workspace runtime admission scenario has empty name")
		}
		if _, duplicate := seen[scenario.Name]; duplicate {
			t.Fatalf("duplicate workspace runtime admission scenario name %q", scenario.Name)
		}
		seen[scenario.Name] = struct{}{}
	}
}

func TestPublishedInteractionTreeScenarioCatalogHasUniqueNames(t *testing.T) {
	t.Parallel()
	scenarios := InteractionTreeScenarios()
	if len(scenarios) != 1 || scenarios[0].Name == "" {
		t.Fatalf("interaction tree scenarios=%#v", scenarios)
	}
}

func TestPublishedRailPlacementRecoveryScenarioCatalogHasUniqueNames(t *testing.T) {
	t.Parallel()
	scenarios := RailPlacementRecoveryScenarios()
	if len(scenarios) != 1 || scenarios[0].Name == "" {
		t.Fatalf("rail placement recovery scenarios=%#v", scenarios)
	}
}

func TestPublishedEditRetryScenarioCatalogHasUniqueNames(t *testing.T) {
	t.Parallel()
	scenarios := EditRetryScenarios()
	if len(scenarios) != 8 {
		t.Fatalf("edit retry scenario count=%d, want 8", len(scenarios))
	}
	seen := make(map[string]struct{}, len(scenarios))
	for _, scenario := range scenarios {
		if scenario.Name == "" {
			t.Fatal("edit retry conformance scenario has an empty name")
		}
		if _, ok := seen[scenario.Name]; ok {
			t.Fatalf("duplicate edit retry conformance scenario name %q", scenario.Name)
		}
		seen[scenario.Name] = struct{}{}
	}
}

func TestScenarioOwnershipIsExplicit(t *testing.T) {
	t.Parallel()
	wantAdapterLifecycle := []string{
		"create empty session",
		"create with initial content",
		"create with typed initial goal",
		"initial Goal exposes execution pending",
		"typed initial goal waits for canonical rail initialization",
		"failed canonical initialization aborts unpublished runtime",
		"create with explicit rail placement",
		"create with authoritative rail placement outside local project registry",
		"resume persisted session",
		"send input",
		"send connector-only input",
		"guidance requires exact target before dispatch",
		"guidance forwards exact target",
		"guidance target mismatch does not dispatch provider and cleans claim",
		"new turns require durable provider acceptance",
		"providerless canonical terminal settles and replays submission",
		"rejected initial submit discards runtime without completing canonical session",
		"duplicate client submit id",
		"exact turn cancel",
		"interactive response",
		"interactive response reuses provider request id across turns",
		"interactive response race",
		"plan decision",
		"initial title cas",
		"get session",
		"list session turns",
		"historical and live settings",
		"pin session",
		"delete session",
		"delete live session before canonical report",
		"delete admission rejection has no canonical side effects",
		"delete admission receives exact canonical closure",
		"delete admission guards changed closure before additional runtime close",
		"purge deleted sessions",
	}
	wantApplicationCore := []string{
		"create empty session",
		"create with initial content",
		"create with typed initial goal",
		"initial Goal exposes execution pending",
		"typed initial goal waits for canonical rail initialization",
		"failed canonical initialization aborts unpublished runtime",
		"create with explicit rail placement",
		"create with authoritative rail placement outside local project registry",
		"resume persisted session",
		"send input",
		"send connector-only input",
		"guidance requires exact target before dispatch",
		"guidance forwards exact target",
		"guidance target mismatch does not dispatch provider and cleans claim",
		"new turns require durable provider acceptance",
		"providerless canonical terminal settles and replays submission",
		"rejected initial submit discards runtime without completing canonical session",
		"duplicate client submit id",
		"initial title cas",
		"get session",
		"list session turns",
		"historical and live settings",
		"pin session",
		"delete session",
		"delete live session before canonical report",
		"delete admission rejection has no canonical side effects",
		"delete admission receives exact canonical closure",
		"delete admission guards changed closure before additional runtime close",
		"purge deleted sessions",
	}
	wantCoordinator := []string{
		"exact turn cancel",
		"interactive response",
		"interactive response reuses provider request id across turns",
		"interactive response race",
		"interactive follow-up recovers through Host admission",
		"plan decision",
		"recover operations before stale turns",
	}
	if got := scenarioNames(Scenarios()); !slices.Equal(got, wantAdapterLifecycle) {
		t.Fatalf("adapter lifecycle scenarios=%v, want %v", got, wantAdapterLifecycle)
	}
	wantEditRetry := []string{
		"edit retry rollback applied response loss is reconciled once",
		"edit retry ambiguous rollback never redispatches",
		"edit retry accepted replacement response loss does not duplicate",
		"edit retry ambiguous replacement without absence proof does not resend",
		"edit retry reconcile is read only",
		"edit retry replacement retry requires proven absence",
		"edit retry direct receipt bypasses acceptance polling",
		"edit retry rollback-confirmed restart enters replacement only",
	}
	if got := scenarioNames(ApplicationCoreScenarios()); !slices.Equal(got, wantApplicationCore) {
		t.Fatalf("application core scenarios=%v, want %v", got, wantApplicationCore)
	}
	if got := scenarioNames(CoordinatorScenarios()); !slices.Equal(got, wantCoordinator) {
		t.Fatalf("coordinator scenarios=%v, want %v", got, wantCoordinator)
	}
	if got := editRetryScenarioNames(EditRetryScenarios()); !slices.Equal(got, wantEditRetry) {
		t.Fatalf("edit retry scenarios=%v, want %v", got, wantEditRetry)
	}
}

func scenarioNames(scenarios []Scenario) []string {
	names := make([]string, 0, len(scenarios))
	for _, scenario := range scenarios {
		names = append(names, scenario.Name)
	}
	return names
}

func editRetryScenarioNames(scenarios []EditRetryScenario) []string {
	names := make([]string, 0, len(scenarios))
	for _, scenario := range scenarios {
		names = append(names, scenario.Name)
	}
	return names
}
