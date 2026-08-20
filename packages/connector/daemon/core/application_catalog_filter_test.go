package host

import (
	"context"
	"testing"
)

type pagedCatalogSource struct {
	pages   map[string]CatalogSourcePage
	queries []CatalogSourcePageQuery
}

func (*pagedCatalogSource) ListCategories(context.Context) ([]CatalogCategory, error) {
	return nil, nil
}

func (source *pagedCatalogSource) ListPage(_ context.Context, query CatalogSourcePageQuery) (CatalogSourcePage, error) {
	source.queries = append(source.queries, query)
	return source.pages[query.PageToken], nil
}

func (*pagedCatalogSource) Refresh(context.Context) (CatalogSnapshot, error) {
	return CatalogSnapshot{}, nil
}

func TestApplicationCatalogPageFiltersInstalledConnectorsBeforePagination(t *testing.T) {
	installed := testConnector("github")
	installed.Installation = Installation{
		State:                  InstallationStateInstalled,
		InstalledVersion:       installed.Release.Version,
		InstalledReleaseID:     installed.Release.ReleaseID,
		InstalledReleaseDigest: installed.Release.ReleaseDigest,
	}
	availableRelease := testConnector("notion").Release
	source := &pagedCatalogSource{pages: map[string]CatalogSourcePage{
		"": {
			SectionID: "other",
			Entries: []CatalogEntry{{
				CategoryID: "other",
				Release:    installed.Release,
			}},
			NextPageToken: "page-2",
		},
		"page-2": {
			SectionID: "other",
			Entries: []CatalogEntry{{
				CategoryID: "other",
				Release:    availableRelease,
			}},
		},
	}}
	repository := newMemoryRepository(installed)
	application := newTestApplicationWithCatalogSource(
		t,
		repository,
		&memoryScheduler{},
		&memoryInstallRuntime{},
		source,
	)

	page, err := application.ListCatalogPage(context.Background(), CatalogPageQuery{
		SectionID:          "other",
		PageSize:           1,
		InstallationFilter: CatalogInstallationFilterNotInstalled,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 1 || page.Items[0].Connector.Key != "notion" || page.NextPageToken != "" {
		t.Fatalf("filtered page = %#v", page)
	}
	if len(source.queries) != 2 || source.queries[0].PageToken != "" || source.queries[1].PageToken != "page-2" {
		t.Fatalf("source queries = %#v", source.queries)
	}
	if _, err := repository.Connector(context.Background(), "notion"); err != nil {
		t.Fatalf("filtered page connector was not cached: %v", err)
	}
}

func TestApplicationCatalogPageTreatsPhysicalRepairAsNotInstalled(t *testing.T) {
	repair := testConnector("github")
	repair.Installation = Installation{
		State:                  InstallationStateFailed,
		InstalledVersion:       repair.Release.Version,
		InstalledReleaseID:     repair.Release.ReleaseID,
		InstalledReleaseDigest: repair.Release.ReleaseDigest,
		FailureCode:            InstallationFailureCodePhysicallyAbsent,
	}
	source := &pagedCatalogSource{pages: map[string]CatalogSourcePage{
		"": {
			SectionID: "other",
			Entries: []CatalogEntry{{
				CategoryID: "other",
				Release:    repair.Release,
			}},
		},
	}}
	application := newTestApplicationWithCatalogSource(
		t,
		newMemoryRepository(repair),
		&memoryScheduler{},
		&memoryInstallRuntime{},
		source,
	)

	page, err := application.ListCatalogPage(context.Background(), CatalogPageQuery{
		SectionID:          "other",
		PageSize:           20,
		InstallationFilter: CatalogInstallationFilterNotInstalled,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 1 || page.Items[0].Connector.Key != "github" {
		t.Fatalf("repair page = %#v", page)
	}
}

func TestApplicationCatalogPageExhaustsInstalledOnlyPages(t *testing.T) {
	github := installedTestConnector("github")
	slack := installedTestConnector("slack")
	source := &pagedCatalogSource{pages: map[string]CatalogSourcePage{
		"": {
			SectionID: "other",
			Entries: []CatalogEntry{{
				CategoryID: "other",
				Release:    github.Release,
			}},
			NextPageToken: "page-2",
		},
		"page-2": {
			SectionID: "other",
			Entries: []CatalogEntry{{
				CategoryID: "other",
				Release:    slack.Release,
			}},
		},
	}}
	application := newTestApplicationWithCatalogSource(
		t,
		newMemoryRepository(github, slack),
		&memoryScheduler{},
		&memoryInstallRuntime{},
		source,
	)

	page, err := application.ListCatalogPage(context.Background(), CatalogPageQuery{
		SectionID:          "other",
		PageSize:           20,
		InstallationFilter: CatalogInstallationFilterNotInstalled,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 0 || page.NextPageToken != "" {
		t.Fatalf("installed-only page = %#v", page)
	}
	if len(source.queries) != 2 {
		t.Fatalf("source queries = %#v", source.queries)
	}
}

func installedTestConnector(key string) Connector {
	connector := testConnector(key)
	connector.Installation = Installation{
		State:                  InstallationStateInstalled,
		InstalledVersion:       connector.Release.Version,
		InstalledReleaseID:     connector.Release.ReleaseID,
		InstalledReleaseDigest: connector.Release.ReleaseDigest,
	}
	return connector
}
