package host

import (
	"context"
	"sync/atomic"
	"testing"
)

type outOfOrderCatalogSource struct {
	oldRelease   Release
	newRelease   Release
	firstStarted chan struct{}
	releaseFirst chan struct{}
	calls        atomic.Int32
}

func (*outOfOrderCatalogSource) ListCategories(context.Context) ([]CatalogCategory, error) {
	return nil, nil
}

func (source *outOfOrderCatalogSource) ListPage(context.Context, CatalogSourcePageQuery) (CatalogSourcePage, error) {
	if source.calls.Add(1) == 1 {
		close(source.firstStarted)
		<-source.releaseFirst
		return CatalogSourcePage{SectionID: "featured", Entries: []CatalogEntry{{
			CategoryID: "featured", Featured: true, Release: source.oldRelease,
		}}}, nil
	}
	return CatalogSourcePage{SectionID: "featured", Entries: []CatalogEntry{{
		CategoryID: "featured", Featured: true, Release: source.newRelease,
	}}}, nil
}

func (*outOfOrderCatalogSource) Refresh(context.Context) (CatalogSnapshot, error) {
	return CatalogSnapshot{}, nil
}

func TestCatalogFetchFenceDropsSlowOlderPage(t *testing.T) {
	oldRelease := testConnector("github").Release
	newRelease := oldRelease
	newRelease.Version = "2.0.0"
	newRelease.ReleaseID = "github@2.0.0"
	newRelease.ReleaseDigest = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
	newRelease.ManifestDigest = "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
	source := &outOfOrderCatalogSource{
		oldRelease: oldRelease, newRelease: newRelease,
		firstStarted: make(chan struct{}), releaseFirst: make(chan struct{}),
	}
	repository := newMemoryRepository(testConnector("github"))
	application := newTestApplication(t, repository, &memoryScheduler{}, &memoryInstallRuntime{}, CatalogSnapshot{})
	application.config.CatalogSource = source
	query := CatalogPageQuery{SectionID: "featured", PageSize: 20}
	firstDone := make(chan error, 1)
	go func() {
		_, err := application.ListCatalogPage(context.Background(), query)
		firstDone <- err
	}()
	<-source.firstStarted
	if _, err := application.ListCatalogPage(context.Background(), query); err != nil {
		t.Fatal(err)
	}
	close(source.releaseFirst)
	if err := <-firstDone; err != nil {
		t.Fatal(err)
	}
	stored, err := repository.Connector(context.Background(), "github")
	if err != nil {
		t.Fatal(err)
	}
	if stored.Release.ReleaseDigest != newRelease.ReleaseDigest {
		t.Fatalf("slow old page replaced newer catalog state: %#v", stored.Release)
	}
}

func TestCatalogFetchFenceDoesNotProjectDelistedConnectorFromSlowOlderPage(t *testing.T) {
	connector := installedTestConnector("github")
	source := &outOfOrderCatalogSource{
		oldRelease: connector.Release, newRelease: connector.Release,
		firstStarted: make(chan struct{}), releaseFirst: make(chan struct{}),
	}
	t.Cleanup(func() {
		select {
		case <-source.releaseFirst:
		default:
			close(source.releaseFirst)
		}
	})
	repository := newMemoryRepository(connector)
	application := newTestApplication(t, repository, &memoryScheduler{}, &memoryInstallRuntime{}, CatalogSnapshot{})
	application.config.CatalogSource = source
	query := CatalogPageQuery{SectionID: "featured", PageSize: 20}
	type pageResult struct {
		page CatalogPage
		err  error
	}
	firstDone := make(chan pageResult, 1)
	go func() {
		page, err := application.ListCatalogPage(context.Background(), query)
		firstDone <- pageResult{page: page, err: err}
	}()

	<-source.firstStarted
	accepted, err := application.RefreshCatalog(context.Background(), Mutation{
		ClientRequestID: "refresh-without-github", ExpectedRevision: repository.revision,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := application.ExecuteOperation(context.Background(), accepted.Operation.OperationID); err != nil {
		t.Fatal(err)
	}
	close(source.releaseFirst)
	result := <-firstDone
	if result.err != nil {
		t.Fatal(result.err)
	}
	if len(result.page.Items) != 0 {
		t.Fatalf("slow page projected delisted connector: %#v", result.page.Items)
	}
	stored, err := repository.Connector(context.Background(), connector.Key)
	if err != nil {
		t.Fatal(err)
	}
	if !connectorRemovedFromCatalog(stored) {
		t.Fatalf("stored connector compatibility = %#v", stored.Compatibility)
	}
}
