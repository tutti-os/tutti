package host

import (
	"context"
	"errors"
	"testing"
)

func TestApplicationCalibrationMarksExplicitlyMissingInstallationAndRestoresIt(t *testing.T) {
	connector := testConnector("github")
	connector.Release.Manifest.Implementation.ManagedStdio.MCP.InstallationProbe =
		&InstallationProbe{Arguments: []string{"--version"}, TimeoutMS: 1_000}
	connector.Installation = Installation{State: InstallationStateInstalled,
		InstalledVersion: connector.Release.Version, InstalledReleaseID: connector.Release.ReleaseID,
		InstalledReleaseDigest: connector.Release.ReleaseDigest}
	connector.Revision = 4
	repository := newMemoryRepository(connector)
	repository.revision = connector.Revision
	runtime := &memoryInstallRuntime{installationResult: InstallationObservation{State: InstallationObservationAbsent}}
	application := newTestApplication(t, repository, &memoryScheduler{}, runtime, CatalogSnapshot{})

	if err := application.CalibrateInstalledConnectorsForScope(context.Background(), OperationScope{}); err != nil {
		t.Fatal(err)
	}
	missing := repository.connectors[connector.Key]
	if missing.Installation.State != InstallationStateFailed ||
		missing.Installation.FailureCode != InstallationFailureCodeProbeAbsent ||
		missing.Installation.InstalledReleaseDigest != connector.Release.ReleaseDigest || missing.Revision != 5 {
		t.Fatalf("missing calibration = %#v", missing)
	}
	if runtime.installationChecks != 1 || len(repository.events) != 1 ||
		repository.events[0].OperationID != "calibrate/operation-2/github" {
		t.Fatalf("checks=%d events=%#v", runtime.installationChecks, repository.events)
	}

	runtime.installationResult.State = InstallationObservationPresent
	if err := application.CalibrateInstalledConnectorsForScope(context.Background(), OperationScope{}); err != nil {
		t.Fatal(err)
	}
	restored := repository.connectors[connector.Key]
	if restored.Installation.State != InstallationStateInstalled || restored.Installation.FailureCode != "" || restored.Revision != 6 {
		t.Fatalf("restored calibration = %#v", restored)
	}
}

func TestApplicationCalibrationPreservesStateForIndeterminateOrUndeclaredProbe(t *testing.T) {
	connector := testConnector("github")
	connector.Installation = Installation{State: InstallationStateInstalled,
		InstalledVersion: connector.Release.Version, InstalledReleaseID: connector.Release.ReleaseID,
		InstalledReleaseDigest: connector.Release.ReleaseDigest}
	repository := newMemoryRepository(connector)
	runtime := &memoryInstallRuntime{installationCheckErr: errors.New("probe timed out")}
	application := newTestApplication(t, repository, &memoryScheduler{}, runtime, CatalogSnapshot{})

	if err := application.CalibrateInstalledConnectorsForScope(context.Background(), OperationScope{}); err != nil {
		t.Fatalf("legacy connector without probe returned error: %v", err)
	}
	if runtime.installationChecks != 0 {
		t.Fatalf("undeclared probe checks = %d", runtime.installationChecks)
	}

	connector = repository.connectors[connector.Key]
	connector.Release.Manifest.Implementation.ManagedStdio.MCP.InstallationProbe =
		&InstallationProbe{Arguments: []string{"--version"}, TimeoutMS: 1_000}
	repository.connectors[connector.Key] = connector
	if err := application.CalibrateInstalledConnectorsForScope(context.Background(), OperationScope{}); err == nil {
		t.Fatal("indeterminate probe error was discarded")
	}
	preserved := repository.connectors[connector.Key]
	if preserved.Installation.State != InstallationStateInstalled || preserved.Installation.FailureCode != "" || len(repository.events) != 0 {
		t.Fatalf("indeterminate probe changed projection: %#v events=%#v", preserved, repository.events)
	}
}
