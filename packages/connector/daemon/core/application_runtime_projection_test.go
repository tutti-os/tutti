package host

import "testing"

func TestApplicationSnapshotProjectsInstalledRuntime(t *testing.T) {
	connector := testManagedAuthorizedConnector("github")
	repository := newMemoryRepository(connector)
	application := newTestApplication(t, repository, &memoryScheduler{}, &memoryInstallRuntime{}, CatalogSnapshot{})
	repository.runtimeConvergences[memoryRuntimeConvergenceKey(OperationScope{}, connector.Key)] = RuntimeConvergence{
		Desired: RuntimeDesired{ConnectorKey: connector.Key, Generation: 2, Enabled: true},
		Observed: RuntimeObserved{DesiredGeneration: 2, BootEpoch: application.config.BootEpoch, Enabled: true,
			Readiness: RuntimeReadiness{State: RuntimeReadinessReady}},
	}

	snapshot, err := application.Snapshot(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if len(snapshot.Connectors) != 1 || snapshot.Connectors[0].Runtime == nil ||
		snapshot.Connectors[0].Runtime.State != ConnectorRuntimeStateStarted {
		t.Fatalf("runtime projection = %#v, want started", snapshot.Connectors)
	}
}

func TestApplicationSnapshotProjectsUnplannedInstalledRuntimeAsStarting(t *testing.T) {
	connector := testManagedAuthorizedConnector("github")
	repository := newMemoryRepository(connector)
	application := newTestApplication(t, repository, &memoryScheduler{}, &memoryInstallRuntime{}, CatalogSnapshot{})

	snapshot, err := application.Snapshot(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if len(snapshot.Connectors) != 1 || snapshot.Connectors[0].Runtime == nil ||
		snapshot.Connectors[0].Runtime.State != ConnectorRuntimeStateStarting {
		t.Fatalf("runtime projection = %#v, want starting", snapshot.Connectors)
	}
}

func TestConnectorRuntimeProjectionUsesCurrentObservedReadiness(t *testing.T) {
	tests := []struct {
		name        string
		convergence RuntimeConvergence
		want        ConnectorRuntimeState
	}{
		{
			name: "started",
			convergence: RuntimeConvergence{
				Desired: RuntimeDesired{Generation: 2, Enabled: true},
				Observed: RuntimeObserved{DesiredGeneration: 2, BootEpoch: "boot-1", Enabled: true,
					Readiness: RuntimeReadiness{State: RuntimeReadinessReady}},
			},
			want: ConnectorRuntimeStateStarted,
		},
		{
			name: "stale observation remains starting",
			convergence: RuntimeConvergence{
				Desired:  RuntimeDesired{Generation: 3, Enabled: true},
				Observed: RuntimeObserved{DesiredGeneration: 2, BootEpoch: "boot-1", Enabled: true},
			},
			want: ConnectorRuntimeStateStarting,
		},
		{
			name: "disabled intent is stopped",
			convergence: RuntimeConvergence{
				Desired: RuntimeDesired{Generation: 3, Enabled: false},
			},
			want: ConnectorRuntimeStateStopped,
		},
		{
			name: "retry debt is failed",
			convergence: RuntimeConvergence{
				Desired:       RuntimeDesired{Generation: 3, Enabled: true},
				LastErrorCode: "runtime_probe_failed",
			},
			want: ConnectorRuntimeStateFailed,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			projection := connectorRuntimeProjection(test.convergence, "boot-1")
			if projection.State != test.want {
				t.Fatalf("runtime state = %q, want %q", projection.State, test.want)
			}
		})
	}
}
