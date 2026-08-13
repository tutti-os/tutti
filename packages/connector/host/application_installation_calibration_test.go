package host

import (
	"context"
	"testing"
)

func TestApplicationCalibrationMarksExplicitlyMissingInstallationAndRestoresIt(t *testing.T) {
	connector := testConnector("github")
	connector.Installation = Installation{State: InstallationStateInstalled,
		InstalledVersion: connector.Release.Version, InstalledReleaseID: connector.Release.ReleaseID,
		InstalledReleaseDigest: connector.Release.ReleaseDigest}
	connector.Revision = 4
	repository := newMemoryRepository(connector)
	repository.revision = connector.Revision
	runtime := &memoryInstallRuntime{installationResult: ReleaseInstallationObservation{State: ReleaseInstallationAbsent}}
	application := newTestApplication(t, repository, &memoryScheduler{}, runtime, CatalogSnapshot{})

	if err := application.CalibrateInstalledConnectorsForScope(context.Background(), OperationScope{}); err != nil {
		t.Fatal(err)
	}
	missing := repository.connectors[connector.Key]
	if missing.Installation.State != InstallationStateFailed ||
		missing.Installation.FailureCode != InstallationFailureCodePhysicallyAbsent ||
		missing.Installation.InstalledReleaseDigest != connector.Release.ReleaseDigest || missing.Revision != 5 {
		t.Fatalf("missing calibration = %#v", missing)
	}
	if runtime.installationInspections != 1 || len(repository.events) != 1 ||
		repository.events[0].OperationID != "inspect/operation-2/github" {
		t.Fatalf("inspections=%d events=%#v", runtime.installationInspections, repository.events)
	}

	runtime.installationResult.State = ReleaseInstallationPresent
	if err := application.CalibrateInstalledConnectorsForScope(context.Background(), OperationScope{}); err != nil {
		t.Fatal(err)
	}
	restored := repository.connectors[connector.Key]
	if restored.Installation.State != InstallationStateInstalled || restored.Installation.FailureCode != "" || restored.Revision != 6 {
		t.Fatalf("restored calibration = %#v", restored)
	}
}

func TestApplicationCalibrationPreservesStateForIndeterminateInspection(t *testing.T) {
	connector := testConnector("github")
	connector.Installation = Installation{State: InstallationStateInstalled,
		InstalledVersion: connector.Release.Version, InstalledReleaseID: connector.Release.ReleaseID,
		InstalledReleaseDigest: connector.Release.ReleaseDigest}
	repository := newMemoryRepository(connector)
	runtime := &memoryInstallRuntime{installationResult: ReleaseInstallationObservation{State: ReleaseInstallationIndeterminate}}
	application := newTestApplication(t, repository, &memoryScheduler{}, runtime, CatalogSnapshot{})

	if err := application.CalibrateInstalledConnectorsForScope(context.Background(), OperationScope{}); err != nil {
		t.Fatalf("indeterminate inspection returned error: %v", err)
	}
	if runtime.installationInspections != 1 {
		t.Fatalf("inspection count = %d", runtime.installationInspections)
	}
	preserved := repository.connectors[connector.Key]
	if preserved.Installation.State != InstallationStateInstalled || preserved.Installation.FailureCode != "" || len(repository.events) != 0 {
		t.Fatalf("indeterminate inspection changed projection: %#v events=%#v", preserved, repository.events)
	}
}

func TestApplicationCalibrationMarksInvalidInstallation(t *testing.T) {
	connector := testConnector("github")
	connector.Installation = Installation{State: InstallationStateInstalled,
		InstalledVersion: connector.Release.Version, InstalledReleaseID: connector.Release.ReleaseID,
		InstalledReleaseDigest: connector.Release.ReleaseDigest}
	repository := newMemoryRepository(connector)
	runtime := &memoryInstallRuntime{installationResult: ReleaseInstallationObservation{State: ReleaseInstallationInvalid}}
	application := newTestApplication(t, repository, &memoryScheduler{}, runtime, CatalogSnapshot{})

	if err := application.CalibrateInstalledConnectorsForScope(context.Background(), OperationScope{}); err != nil {
		t.Fatal(err)
	}
	invalid := repository.connectors[connector.Key]
	if invalid.Installation.State != InstallationStateFailed || invalid.Installation.FailureCode != InstallationFailureCodePhysicallyInvalid {
		t.Fatalf("invalid calibration = %#v", invalid)
	}
}
