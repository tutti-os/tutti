// Package agentactivity re-exports the agent activity persistence contract,
// which now lives in the embeddable packages/agent/store-sqlite module. The
// aliases keep tuttid-internal import paths and type identities stable.
package agentactivity

import (
	agentstore "github.com/tutti-os/tutti/packages/agent/store-sqlite"
)

type Repository = agentstore.Repository

type ClearSessionsResult = agentstore.ClearSessionsResult

type MessageOrder = agentstore.MessageOrder

const (
	MessageOrderAsc      = agentstore.MessageOrderAsc
	MessageOrderDesc     = agentstore.MessageOrderDesc
	PinnedSessionPageKey = agentstore.PinnedSessionPageKey
)

type ListSessionMessagesInput = agentstore.ListSessionMessagesInput

type ListWorkspaceGeneratedFilesInput = agentstore.ListWorkspaceGeneratedFilesInput

type GeneratedFile = agentstore.GeneratedFile

type GeneratedFileList = agentstore.GeneratedFileList

type ListSessionSectionInput = agentstore.ListSessionSectionInput

type SessionSectionPage = agentstore.SessionSectionPage

type Session = agentstore.Session

type SessionStateReport = agentstore.SessionStateReport

type StateReportResult = agentstore.StateReportResult

type SessionMessageReport = agentstore.SessionMessageReport

type MessageUpdate = agentstore.MessageUpdate

type MessageReportResult = agentstore.MessageReportResult

type Message = agentstore.Message

type MessagePage = agentstore.MessagePage
