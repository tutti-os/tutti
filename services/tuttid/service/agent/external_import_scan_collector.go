package agent

import "sort"

type externalScanRetention uint8

const (
	externalScanSummaryOnly externalScanRetention = iota
	externalScanRetainTranscripts
)

type externalScanCollector struct {
	data      *externalScanData
	projects  map[string]*ExternalImportProject
	retention externalScanRetention
}

func newExternalScanCollector(data *externalScanData, retention externalScanRetention) *externalScanCollector {
	return &externalScanCollector{
		data:      data,
		projects:  map[string]*ExternalImportProject{},
		retention: retention,
	}
}

func (c *externalScanCollector) add(session externalImportedSession) {
	project, ok := projectFromExternalSession(session)
	if !ok {
		c.data.result.SkippedSessions++
		return
	}
	if c.retention == externalScanRetainTranscripts {
		c.data.sessions = append(c.data.sessions, session)
	}
	c.data.result.ScannedSessions++
	c.data.result.ScannedMessages += len(session.Messages)
	c.data.result.Sessions = append(c.data.result.Sessions, externalImportSessionSummary(session, project.Path))
	upsertExternalImportProject(c.projects, project, session.Provider)
}

func (c *externalScanCollector) finish() {
	for _, project := range c.projects {
		sort.Strings(project.Providers)
		c.data.result.Projects = append(c.data.result.Projects, *project)
	}
	sort.SliceStable(c.data.result.Projects, func(left, right int) bool {
		if c.data.result.Projects[left].LastUpdatedAtUnixMS == c.data.result.Projects[right].LastUpdatedAtUnixMS {
			return c.data.result.Projects[left].Path < c.data.result.Projects[right].Path
		}
		return c.data.result.Projects[left].LastUpdatedAtUnixMS > c.data.result.Projects[right].LastUpdatedAtUnixMS
	})
	sort.SliceStable(c.data.result.Sessions, func(left, right int) bool {
		if c.data.result.Sessions[left].LastUpdatedAtUnixMS == c.data.result.Sessions[right].LastUpdatedAtUnixMS {
			return c.data.result.Sessions[left].ID < c.data.result.Sessions[right].ID
		}
		return c.data.result.Sessions[left].LastUpdatedAtUnixMS > c.data.result.Sessions[right].LastUpdatedAtUnixMS
	})
}
