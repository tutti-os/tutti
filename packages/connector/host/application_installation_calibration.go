package host

import (
	"context"
	"errors"
	"fmt"
	"strings"
)

const InstallationFailureCodeProbeAbsent = "connector_installation_probe_absent"

// CalibrateInstalledConnectorsForScope compares durable installation truth
// with explicit probes from releases that the user previously installed. A
// probe is never executed for a catalog-only connector. Indeterminate checks
// preserve SQLite state and are returned for diagnostics.
func (application *Application) CalibrateInstalledConnectorsForScope(
	ctx context.Context,
	scope OperationScope,
) error {
	if application == nil || application.config.InstallationChecker == nil {
		return nil
	}
	snapshot, err := application.config.Repository.Snapshot(ctx)
	if err != nil {
		return err
	}
	var calibrationErrors []error
	for _, connector := range snapshot.Connectors {
		if !installationCalibrationCandidate(connector) {
			continue
		}
		release, evidenceErr := application.installedReleaseEvidence(ctx, connector)
		if evidenceErr != nil {
			calibrationErrors = append(calibrationErrors, fmt.Errorf("calibrate connector %s: %w", connector.Key, evidenceErr))
			continue
		}
		if !releaseHasInstallationProbe(release) {
			continue
		}
		installedConnector := connector
		installedConnector.Release = release
		operationID := "calibrate/" + application.config.BootEpoch + "/" + connector.Key
		operation := Operation{OperationID: operationID, ConnectorKey: connector.Key, Scope: scope}
		binding, bindingErr := application.resolveRuntimeBinding(ctx, operation, installedConnector, release, RuntimeBindingPurposeInstallationProbe)
		if bindingErr != nil {
			calibrationErrors = append(calibrationErrors, fmt.Errorf("calibrate connector %s binding: %w", connector.Key, bindingErr))
			continue
		}
		clear(binding.CredentialBrokerGrant)
		generation := HostGeneration{BootEpoch: application.config.BootEpoch, Generation: nextGeneration(connector.Revision)}
		observation, checkErr := application.config.InstallationChecker.CheckInstallation(ctx, InstallationCheckRequest{
			OperationID: operationID, Scope: scope, ConnectionID: binding.ConnectionID,
			Connector: installedConnector, Generation: generation,
		})
		if checkErr != nil {
			calibrationErrors = append(calibrationErrors, fmt.Errorf("calibrate connector %s installation: %w", connector.Key, checkErr))
			continue
		}
		if observation.ConnectorKey != connector.Key || observation.ReleaseDigest != release.ReleaseDigest ||
			(observation.State != InstallationObservationPresent && observation.State != InstallationObservationAbsent) {
			calibrationErrors = append(calibrationErrors, fmt.Errorf("calibrate connector %s: installation checker returned a mismatched observation", connector.Key))
			continue
		}
		if err := application.applyInstallationObservation(ctx, connector.Key, operationID, release.ReleaseDigest, observation.State); err != nil {
			calibrationErrors = append(calibrationErrors, fmt.Errorf("calibrate connector %s projection: %w", connector.Key, err))
		}
	}
	return errors.Join(calibrationErrors...)
}

func installationCalibrationCandidate(connector Connector) bool {
	if strings.TrimSpace(connector.Installation.InstalledReleaseDigest) == "" {
		return false
	}
	return connector.Installation.State == InstallationStateInstalled ||
		(connector.Installation.State == InstallationStateFailed &&
			connector.Installation.FailureCode == InstallationFailureCodeProbeAbsent)
}

func releaseHasInstallationProbe(release Release) bool {
	managed := release.Manifest.Implementation.ManagedStdio
	return managed != nil && ((managed.MCP != nil && managed.MCP.InstallationProbe != nil) ||
		(managed.CLI != nil && managed.CLI.InstallationProbe != nil))
}

func (application *Application) applyInstallationObservation(
	ctx context.Context,
	connectorKey, operationID, releaseDigest string,
	state InstallationObservationState,
) error {
	return application.config.Repository.Transaction(ctx, func(tx Transaction) error {
		connector, err := tx.Connector(connectorKey)
		if err != nil {
			return err
		}
		if connector.Installation.InstalledReleaseDigest != releaseDigest || !installationCalibrationCandidate(connector) {
			return nil
		}
		next := connector.Installation
		switch state {
		case InstallationObservationPresent:
			if next.State == InstallationStateInstalled {
				return nil
			}
			next.State, next.FailureCode = InstallationStateInstalled, ""
		case InstallationObservationAbsent:
			if next.State == InstallationStateFailed && next.FailureCode == InstallationFailureCodeProbeAbsent {
				return nil
			}
			next.State, next.FailureCode = InstallationStateFailed, InstallationFailureCodeProbeAbsent
		default:
			return errors.New("installation observation state is invalid")
		}
		revision := tx.AdvanceRevision()
		connector.Installation = next
		connector.Revision = revision
		if err := tx.SaveConnector(connector); err != nil {
			return err
		}
		return tx.EnqueueConnectorMarketChanged(ChangedEvent{ConnectorKey: connector.Key,
			OperationID: operationID, Revision: revision})
	})
}
