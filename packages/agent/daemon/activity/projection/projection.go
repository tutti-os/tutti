// Package projection preserves the historical daemon import path for the
// canonical activity projection contract. New consumers should import
// store-sqlite/canonical directly.
package projection

import canonical "github.com/tutti-os/tutti/packages/agent/store-sqlite/canonical"

type SessionSnapshot = canonical.SessionSnapshot
type SessionStateReport = canonical.SessionStateReport
type SessionProjection = canonical.SessionProjection
type MessageSnapshot = canonical.MessageSnapshot
type MessageUpdate = canonical.MessageUpdate

func ProjectSessionState(existing SessionSnapshot, hasExisting bool, report SessionStateReport, nowUnixMS int64) SessionProjection {
	return canonical.ProjectSessionState(existing, hasExisting, report, nowUnixMS)
}

func ProjectMessageUpdate(existing MessageSnapshot, hasExisting bool, update MessageUpdate, version uint64, nowUnixMS int64) (MessageSnapshot, bool) {
	return canonical.ProjectMessageUpdate(existing, hasExisting, update, version, nowUnixMS)
}

func MergeMessageStatus(existing, incoming string) string {
	return canonical.MergeMessageStatus(existing, incoming)
}

func IsTerminalMessageStatus(status string) bool {
	return canonical.IsTerminalMessageStatus(status)
}

func CanonicalSessionStatus(lifecycleStatus, currentPhase string) string {
	return canonical.CanonicalSessionStatus(lifecycleStatus, currentPhase)
}
