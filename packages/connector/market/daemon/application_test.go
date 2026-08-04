package daemon

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestApplicationInstallIsDurableAndIdempotent(t *testing.T) {
	repository := newMemoryRepository(testConnector("github"))
	scheduler := &memoryScheduler{}
	application := newTestApplication(t, repository, scheduler, &memoryInstaller{}, CatalogSnapshot{})
	command := ConnectorMutation{
		Mutation:     Mutation{ClientRequestID: "request-1", ExpectedRevision: 0},
		ConnectorKey: "github",
	}

	accepted, err := application.Install(context.Background(), command)
	if err != nil {
		t.Fatal(err)
	}
	if accepted.Connector == nil || accepted.Connector.Installation.State != InstallationStateInstalling {
		t.Fatalf("connector = %#v", accepted.Connector)
	}
	if accepted.Operation.State != OperationStateAccepted || accepted.Revision != 1 {
		t.Fatalf("result = %#v", accepted)
	}

	retried, err := application.Install(context.Background(), command)
	if err != nil {
		t.Fatal(err)
	}
	if retried.Operation.OperationID != accepted.Operation.OperationID {
		t.Fatalf("retry operation = %q, want %q", retried.Operation.OperationID, accepted.Operation.OperationID)
	}
	if repository.revision != 1 {
		t.Fatalf("revision = %d, want 1", repository.revision)
	}
	if len(scheduler.operationIDs) != 2 {
		t.Fatalf("scheduled operations = %#v", scheduler.operationIDs)
	}
}

func TestApplicationExecutesAcceptedInstall(t *testing.T) {
	repository := newMemoryRepository(testConnector("github"))
	scheduler := &memoryScheduler{}
	installer := &memoryInstaller{}
	application := newTestApplication(t, repository, scheduler, installer, CatalogSnapshot{})
	accepted, err := application.Install(context.Background(), ConnectorMutation{
		Mutation:     Mutation{ClientRequestID: "request-1", ExpectedRevision: 0},
		ConnectorKey: "github",
	})
	if err != nil {
		t.Fatal(err)
	}

	if err := application.ExecuteOperation(context.Background(), accepted.Operation.OperationID); err != nil {
		t.Fatal(err)
	}
	installed, err := repository.Connector(context.Background(), "github", "")
	if err != nil {
		t.Fatal(err)
	}
	operation, err := repository.Operation(context.Background(), accepted.Operation.OperationID)
	if err != nil {
		t.Fatal(err)
	}
	if installed.Installation.State != InstallationStateInstalled || installed.Installation.InstalledVersion != "1.0.0" {
		t.Fatalf("installation = %#v", installed.Installation)
	}
	if operation.State != OperationStateCompleted || installer.installs != 1 {
		t.Fatalf("operation = %#v, installs = %d", operation, installer.installs)
	}
}

func TestApplicationSingleFlightsConcurrentOperationExecution(t *testing.T) {
	repository := newMemoryRepository(testConnector("github"))
	scheduler := &memoryScheduler{}
	installer := newBlockingInstaller()
	application := newTestApplication(t, repository, scheduler, installer, CatalogSnapshot{})
	accepted, err := application.Install(context.Background(), ConnectorMutation{
		Mutation:     Mutation{ClientRequestID: "request-1", ExpectedRevision: 0},
		ConnectorKey: "github",
	})
	if err != nil {
		t.Fatal(err)
	}

	firstDone := make(chan error, 1)
	go func() {
		firstDone <- application.ExecuteOperation(context.Background(), accepted.Operation.OperationID)
	}()
	select {
	case <-installer.started:
	case <-time.After(time.Second):
		t.Fatal("first operation did not reach installer")
	}

	secondDone := make(chan error, 1)
	go func() {
		secondDone <- application.ExecuteOperation(context.Background(), accepted.Operation.OperationID)
	}()
	select {
	case err := <-secondDone:
		t.Fatalf("second execution returned before the first completed: %v", err)
	case <-time.After(50 * time.Millisecond):
	}

	close(installer.release)
	if err := <-firstDone; err != nil {
		t.Fatalf("first execution error = %v", err)
	}
	if err := <-secondDone; err != nil {
		t.Fatalf("second execution error = %v", err)
	}
	if installs := installer.installs.Load(); installs != 1 {
		t.Fatalf("installer calls = %d, want 1", installs)
	}
}

func TestApplicationSharesConcurrentOperationFailureAndClearsFlight(t *testing.T) {
	repository := newMemoryRepository(testConnector("github"))
	scheduler := &memoryScheduler{}
	cause := errors.New("installer unavailable")
	installer := newBlockingInstallerWithError(cause)
	application := newTestApplication(t, repository, scheduler, installer, CatalogSnapshot{})
	accepted, err := application.Install(context.Background(), ConnectorMutation{
		Mutation:     Mutation{ClientRequestID: "request-1", ExpectedRevision: 0},
		ConnectorKey: "github",
	})
	if err != nil {
		t.Fatal(err)
	}

	firstDone := make(chan error, 1)
	go func() {
		firstDone <- application.ExecuteOperation(context.Background(), accepted.Operation.OperationID)
	}()
	select {
	case <-installer.started:
	case <-time.After(time.Second):
		t.Fatal("first operation did not reach installer")
	}

	secondDone := make(chan error, 1)
	go func() {
		secondDone <- application.ExecuteOperation(context.Background(), accepted.Operation.OperationID)
	}()
	select {
	case err := <-secondDone:
		t.Fatalf("second execution returned before the first completed: %v", err)
	case <-time.After(50 * time.Millisecond):
	}

	close(installer.release)
	firstErr := <-firstDone
	secondErr := <-secondDone
	for name, err := range map[string]error{"first": firstErr, "second": secondErr} {
		var domainError *DomainError
		if !errors.As(err, &domainError) || !errors.Is(err, cause) {
			t.Errorf("%s error = %#v, want install domain error caused by %v", name, err, cause)
		}
	}
	if installs := installer.installs.Load(); installs != 1 {
		t.Fatalf("installer calls = %d, want 1", installs)
	}

	operation, err := repository.Operation(context.Background(), accepted.Operation.OperationID)
	if err != nil {
		t.Fatal(err)
	}
	if operation.State != OperationStateFailed {
		t.Fatalf("operation state = %q, want failed", operation.State)
	}
	if err := application.ExecuteOperation(context.Background(), accepted.Operation.OperationID); err != nil {
		t.Fatalf("terminal operation after flight cleanup = %v", err)
	}
}

func TestApplicationRejectsConcurrentConnectorOperation(t *testing.T) {
	repository := newMemoryRepository(testConnector("github"))
	application := newTestApplication(t, repository, &memoryScheduler{}, &memoryInstaller{}, CatalogSnapshot{})
	if _, err := application.Install(context.Background(), ConnectorMutation{
		Mutation:     Mutation{ClientRequestID: "install-1", ExpectedRevision: 0},
		ConnectorKey: "github",
	}); err != nil {
		t.Fatal(err)
	}
	_, err := application.Uninstall(context.Background(), ConnectorMutation{
		Mutation:     Mutation{ClientRequestID: "uninstall-1", ExpectedRevision: 1},
		ConnectorKey: "github",
	})
	var domainError *DomainError
	if !errors.As(err, &domainError) || domainError.Code != ErrorCodeOperationInProgress {
		t.Fatalf("error = %#v", err)
	}
}

func TestApplicationRefreshKeepsUnknownImplementationVisible(t *testing.T) {
	repository := newMemoryRepository()
	scheduler := &memoryScheduler{}
	application := newTestApplication(t, repository, scheduler, &memoryInstaller{}, CatalogSnapshot{
		SourceRevision: "catalog-2",
		Manifests: []Manifest{{
			SchemaVersion:     "1",
			Key:               "future-connector",
			Version:           "2.0.0",
			DisplayName:       "Future Connector",
			Artifact:          testArtifact(),
			Implementation:    Implementation{Kind: "future_runtime"},
			AuthorizationKind: "none",
		}},
	})
	accepted, err := application.RefreshCatalog(context.Background(), Mutation{
		ClientRequestID:  "refresh-1",
		ExpectedRevision: 0,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := application.ExecuteOperation(context.Background(), accepted.Operation.OperationID); err != nil {
		t.Fatal(err)
	}
	connector, err := repository.Connector(context.Background(), "future-connector", "")
	if err != nil {
		t.Fatal(err)
	}
	if connector.Compatibility.State != CompatibilityStateUnsupportedImplementation {
		t.Fatalf("compatibility = %#v", connector.Compatibility)
	}
	if repository.catalogState != CatalogStateReady || repository.sourceRevision != "catalog-2" {
		t.Fatalf("catalog state = %q, source revision = %q", repository.catalogState, repository.sourceRevision)
	}
}

func TestApplicationRejectsStaleRevisionBeforeMutation(t *testing.T) {
	repository := newMemoryRepository(testConnector("github"))
	repository.revision = 4
	application := newTestApplication(t, repository, &memoryScheduler{}, &memoryInstaller{}, CatalogSnapshot{})
	_, err := application.Install(context.Background(), ConnectorMutation{
		Mutation:     Mutation{ClientRequestID: "request-1", ExpectedRevision: 3},
		ConnectorKey: "github",
	})
	var domainError *DomainError
	if !errors.As(err, &domainError) || domainError.Code != ErrorCodeRevisionConflict {
		t.Fatalf("error = %#v", err)
	}
	if len(repository.operations) != 0 {
		t.Fatalf("operations = %#v", repository.operations)
	}
}

func newTestApplication(
	t *testing.T,
	repository *memoryRepository,
	scheduler *memoryScheduler,
	installer ArtifactInstaller,
	catalog CatalogSnapshot,
) *Application {
	t.Helper()
	nextID := 0
	application, err := NewApplication(ApplicationConfig{
		Repository:             repository,
		CatalogSource:          catalogSourceFunc(func(context.Context) (CatalogSnapshot, error) { return catalog, nil }),
		Installer:              installer,
		Authorization:          authorizationProviderStub{},
		Compatibility:          compatibilityEvaluatorStub{},
		Scheduler:              scheduler,
		Events:                 eventPublisherStub{},
		ImplementationRegistry: NewImplementationRegistry(map[string]ImplementationValidator{"mcp_stdio": nil}),
		Now:                    func() time.Time { return time.Date(2026, 8, 3, 0, 0, 0, 0, time.UTC) },
		NewID: func() (string, error) {
			nextID++
			return fmt.Sprintf("operation-%d", nextID), nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	return application
}

func testConnector(key string) Connector {
	return Connector{
		Key: key,
		Manifest: Manifest{
			SchemaVersion:     "1",
			Key:               key,
			Version:           "1.0.0",
			DisplayName:       key,
			Artifact:          testArtifact(),
			Implementation:    Implementation{Kind: "mcp_stdio"},
			AuthorizationKind: "none",
		},
		Installation:  Installation{State: InstallationStateNotInstalled},
		Authorization: Authorization{State: AuthorizationStateNotRequired},
		Compatibility: Compatibility{State: CompatibilityStateSupported},
	}
}

type catalogSourceFunc func(context.Context) (CatalogSnapshot, error)

func (source catalogSourceFunc) Refresh(ctx context.Context) (CatalogSnapshot, error) {
	return source(ctx)
}

type memoryScheduler struct {
	operationIDs []string
}

func (scheduler *memoryScheduler) Schedule(_ context.Context, operationID string) error {
	scheduler.operationIDs = append(scheduler.operationIDs, operationID)
	return nil
}

type memoryInstaller struct {
	installs   int
	uninstalls int
}

func (installer *memoryInstaller) Install(context.Context, Manifest) error {
	installer.installs++
	return nil
}

func (installer *memoryInstaller) Uninstall(context.Context, Connector) error {
	installer.uninstalls++
	return nil
}

type blockingInstaller struct {
	started  chan struct{}
	release  chan struct{}
	once     sync.Once
	installs atomic.Int32
	err      error
}

func newBlockingInstaller() *blockingInstaller {
	return newBlockingInstallerWithError(nil)
}

func newBlockingInstallerWithError(err error) *blockingInstaller {
	return &blockingInstaller{
		started: make(chan struct{}),
		release: make(chan struct{}),
		err:     err,
	}
}

func (installer *blockingInstaller) Install(ctx context.Context, _ Manifest) error {
	installer.installs.Add(1)
	installer.once.Do(func() { close(installer.started) })
	select {
	case <-installer.release:
		return installer.err
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (installer *blockingInstaller) Uninstall(context.Context, Connector) error {
	return nil
}

type authorizationProviderStub struct{}

func (authorizationProviderStub) Begin(context.Context, Connector, string) (string, error) {
	return "https://example.test/authorize", nil
}

func (authorizationProviderStub) Disconnect(context.Context, Connector) error {
	return nil
}

type compatibilityEvaluatorStub struct{}

func (compatibilityEvaluatorStub) Evaluate(Manifest) Compatibility {
	return Compatibility{State: CompatibilityStateSupported}
}

type eventPublisherStub struct{}

func (eventPublisherStub) ConnectorMarketChanged(context.Context, ChangedEvent) error {
	return nil
}

type memoryRepository struct {
	revision       uint64
	catalogState   CatalogState
	sourceRevision string
	connectors     map[string]Connector
	operations     map[string]Operation
}

func newMemoryRepository(connectors ...Connector) *memoryRepository {
	repository := &memoryRepository{
		catalogState: CatalogStateStale,
		connectors:   map[string]Connector{},
		operations:   map[string]Operation{},
	}
	for _, connector := range connectors {
		repository.connectors[connector.Key] = connector
	}
	return repository
}

func (repository *memoryRepository) Snapshot(_ context.Context, _ string) (Snapshot, error) {
	connectors := make([]Connector, 0, len(repository.connectors))
	for _, connector := range repository.connectors {
		connectors = append(connectors, connector)
	}
	sort.Slice(connectors, func(left, right int) bool { return connectors[left].Key < connectors[right].Key })
	operations := make([]Operation, 0, len(repository.operations))
	for _, operation := range repository.operations {
		operations = append(operations, operation)
	}
	return Snapshot{
		CatalogState:   repository.catalogState,
		Connectors:     connectors,
		Operations:     operations,
		Revision:       repository.revision,
		SourceRevision: repository.sourceRevision,
	}, nil
}

func (repository *memoryRepository) Connector(_ context.Context, connectorKey, _ string) (Connector, error) {
	connector, ok := repository.connectors[connectorKey]
	if !ok {
		return Connector{}, ErrNotFound
	}
	return connector, nil
}

func (repository *memoryRepository) Operation(_ context.Context, operationID string) (Operation, error) {
	operation, ok := repository.operations[operationID]
	if !ok {
		return Operation{}, ErrNotFound
	}
	return operation, nil
}

func (repository *memoryRepository) Transaction(_ context.Context, fn func(Transaction) error) error {
	transaction := &memoryTransaction{
		revision:       repository.revision,
		catalogState:   repository.catalogState,
		sourceRevision: repository.sourceRevision,
		connectors:     cloneConnectors(repository.connectors),
		operations:     cloneOperations(repository.operations),
	}
	if err := fn(transaction); err != nil {
		return err
	}
	repository.revision = transaction.revision
	repository.catalogState = transaction.catalogState
	repository.sourceRevision = transaction.sourceRevision
	repository.connectors = transaction.connectors
	repository.operations = transaction.operations
	return nil
}

func (repository *memoryRepository) RecoverableOperations(context.Context) ([]Operation, error) {
	var operations []Operation
	for _, operation := range repository.operations {
		if operation.State == OperationStateAccepted || operation.State == OperationStateRunning {
			operations = append(operations, operation)
		}
	}
	return operations, nil
}

type memoryTransaction struct {
	revision       uint64
	catalogState   CatalogState
	sourceRevision string
	connectors     map[string]Connector
	operations     map[string]Operation
}

func (transaction *memoryTransaction) Revision() uint64 { return transaction.revision }

func (transaction *memoryTransaction) AdvanceRevision() uint64 {
	transaction.revision++
	return transaction.revision
}

func (transaction *memoryTransaction) Connectors() ([]Connector, error) {
	connectors := make([]Connector, 0, len(transaction.connectors))
	for _, connector := range transaction.connectors {
		connectors = append(connectors, connector)
	}
	return connectors, nil
}

func (transaction *memoryTransaction) Connector(connectorKey string) (Connector, error) {
	connector, ok := transaction.connectors[connectorKey]
	if !ok {
		return Connector{}, ErrNotFound
	}
	return connector, nil
}

func (transaction *memoryTransaction) Operation(operationID string) (Operation, error) {
	operation, ok := transaction.operations[operationID]
	if !ok {
		return Operation{}, ErrNotFound
	}
	return operation, nil
}

func (transaction *memoryTransaction) OperationByClientRequestID(clientRequestID string) (*Operation, error) {
	for _, operation := range transaction.operations {
		if operation.ClientRequestID == clientRequestID {
			copy := operation
			return &copy, nil
		}
	}
	return nil, nil
}

func (transaction *memoryTransaction) ActiveOperation(connectorKey string) (*Operation, error) {
	for _, operation := range transaction.operations {
		if operation.ConnectorKey == connectorKey &&
			(operation.State == OperationStateAccepted || operation.State == OperationStateRunning) {
			copy := operation
			return &copy, nil
		}
	}
	return nil, nil
}

func (transaction *memoryTransaction) SaveCatalogRevision(sourceRevision string) error {
	transaction.sourceRevision = sourceRevision
	return nil
}

func (transaction *memoryTransaction) SetCatalogState(state CatalogState) error {
	transaction.catalogState = state
	return nil
}

func (transaction *memoryTransaction) SaveConnector(connector Connector) error {
	transaction.connectors[connector.Key] = connector
	return nil
}

func (transaction *memoryTransaction) DeleteConnector(connectorKey string) error {
	delete(transaction.connectors, connectorKey)
	return nil
}

func (transaction *memoryTransaction) SaveOperation(operation Operation) error {
	transaction.operations[operation.OperationID] = operation
	return nil
}

func (transaction *memoryTransaction) SetWorkspaceBinding(
	connectorKey string,
	binding WorkspaceBinding,
) (Connector, error) {
	connector, ok := transaction.connectors[connectorKey]
	if !ok {
		return Connector{}, ErrNotFound
	}
	connector.WorkspaceBinding = &binding
	return connector, nil
}

func cloneConnectors(source map[string]Connector) map[string]Connector {
	cloned := make(map[string]Connector, len(source))
	for key, connector := range source {
		cloned[key] = connector
	}
	return cloned
}

func cloneOperations(source map[string]Operation) map[string]Operation {
	cloned := make(map[string]Operation, len(source))
	for key, operation := range source {
		cloned[key] = operation
	}
	return cloned
}
