package api

import (
	"context"
	"encoding/json"
	"errors"

	market "github.com/tutti-os/tutti/packages/connector/host"
	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
)

func (api DaemonAPI) GetConnectorMarket(
	ctx context.Context,
	_ tuttigenerated.GetConnectorMarketRequestObject,
) (tuttigenerated.GetConnectorMarketResponseObject, error) {
	if api.ConnectorMarketService == nil {
		return tuttigenerated.GetConnectorMarket503JSONResponse{ConnectorMarketUnavailableErrorJSONResponse: connectorMarketUnavailableError()}, nil
	}
	var snapshot market.Snapshot
	var err error
	if scoped, ok := api.ConnectorMarketService.(market.ScopedSnapshotReader); ok {
		snapshot, err = scoped.SnapshotForScope(ctx, market.OperationScope{AccountID: api.connectorMarketAccountID()})
	} else {
		snapshot, err = api.ConnectorMarketService.Snapshot(ctx)
	}
	if err != nil {
		return connectorMarketGetSnapshotError(err), nil
	}
	if _, scoped := api.ConnectorMarketService.(market.ScopedSnapshotReader); !scoped {
		if err := api.overlayConnectorAuthorizationProjections(ctx, snapshot.Connectors); err != nil {
			return connectorMarketGetSnapshotError(err), nil
		}
	}
	projected, err := projectConnectorMarket[tuttigenerated.ConnectorMarketSnapshot](snapshot)
	if err != nil {
		return nil, err
	}
	return tuttigenerated.GetConnectorMarket200JSONResponse(projected), nil
}

func (api DaemonAPI) ListConnectorMarketCategories(
	ctx context.Context,
	_ tuttigenerated.ListConnectorMarketCategoriesRequestObject,
) (tuttigenerated.ListConnectorMarketCategoriesResponseObject, error) {
	if api.ConnectorMarketService == nil {
		return tuttigenerated.ListConnectorMarketCategories503JSONResponse{ConnectorMarketUnavailableErrorJSONResponse: connectorMarketUnavailableError()}, nil
	}
	categories, err := api.ConnectorMarketService.ListCatalogCategories(ctx)
	if err != nil {
		payload, _ := connectorMarketError(err)
		return tuttigenerated.ListConnectorMarketCategories503JSONResponse{ConnectorMarketUnavailableErrorJSONResponse: unavailableConnectorMarketResponse(payload)}, nil
	}
	projected, err := projectConnectorMarket[tuttigenerated.ConnectorMarketCategoriesResponse](struct {
		Categories []market.CatalogCategory `json:"categories"`
	}{Categories: categories})
	if err != nil {
		return nil, err
	}
	return tuttigenerated.ListConnectorMarketCategories200JSONResponse(projected), nil
}

func (api DaemonAPI) ListConnectorMarketCatalog(
	ctx context.Context,
	request tuttigenerated.ListConnectorMarketCatalogRequestObject,
) (tuttigenerated.ListConnectorMarketCatalogResponseObject, error) {
	if api.ConnectorMarketService == nil {
		return tuttigenerated.ListConnectorMarketCatalog503JSONResponse{ConnectorMarketUnavailableErrorJSONResponse: connectorMarketUnavailableError()}, nil
	}
	pageSize := 20
	if request.Params.PageSize != nil {
		pageSize = *request.Params.PageSize
	}
	pageToken := ""
	if request.Params.PageToken != nil {
		pageToken = *request.Params.PageToken
	}
	installationFilter := market.CatalogInstallationFilter("")
	if request.Params.Installation != nil {
		installationFilter = market.CatalogInstallationFilter(*request.Params.Installation)
	}
	page, err := api.ConnectorMarketService.ListCatalogPage(ctx, market.CatalogPageQuery{
		SectionID: request.Params.SectionId, PageSize: pageSize, PageToken: pageToken, InstallationFilter: installationFilter,
	})
	if err != nil {
		payload, status := connectorMarketError(err)
		if status == 400 {
			return tuttigenerated.ListConnectorMarketCatalog400JSONResponse{ConnectorMarketInvalidRequestErrorJSONResponse: invalidConnectorMarketResponse(payload)}, nil
		}
		return tuttigenerated.ListConnectorMarketCatalog503JSONResponse{ConnectorMarketUnavailableErrorJSONResponse: unavailableConnectorMarketResponse(payload)}, nil
	}
	pageConnectors := make([]market.Connector, len(page.Items))
	for index := range page.Items {
		pageConnectors[index] = page.Items[index].Connector
	}
	if err := api.overlayConnectorAuthorizationProjections(ctx, pageConnectors); err != nil {
		payload, _ := connectorMarketError(err)
		return tuttigenerated.ListConnectorMarketCatalog503JSONResponse{ConnectorMarketUnavailableErrorJSONResponse: unavailableConnectorMarketResponse(payload)}, nil
	}
	for index := range page.Items {
		page.Items[index].Connector = pageConnectors[index]
	}
	projected, err := projectConnectorMarket[tuttigenerated.ConnectorMarketCatalogPage](page)
	if err != nil {
		return nil, err
	}
	return tuttigenerated.ListConnectorMarketCatalog200JSONResponse(projected), nil
}

func (api DaemonAPI) GetConnectorMarketConnector(
	ctx context.Context,
	request tuttigenerated.GetConnectorMarketConnectorRequestObject,
) (tuttigenerated.GetConnectorMarketConnectorResponseObject, error) {
	if api.ConnectorMarketService == nil {
		return tuttigenerated.GetConnectorMarketConnector503JSONResponse{ConnectorMarketUnavailableErrorJSONResponse: connectorMarketUnavailableError()}, nil
	}
	connector, err := api.ConnectorMarketService.GetConnector(ctx, request.ConnectorKey)
	if err != nil {
		payload, status := connectorMarketError(err)
		switch status {
		case 400:
			return tuttigenerated.GetConnectorMarketConnector400JSONResponse{ConnectorMarketInvalidRequestErrorJSONResponse: invalidConnectorMarketResponse(payload)}, nil
		case 404:
			return tuttigenerated.GetConnectorMarketConnector404JSONResponse{ConnectorMarketNotFoundErrorJSONResponse: notFoundConnectorMarketResponse(payload)}, nil
		default:
			return tuttigenerated.GetConnectorMarketConnector503JSONResponse{ConnectorMarketUnavailableErrorJSONResponse: unavailableConnectorMarketResponse(payload)}, nil
		}
	}
	projectedConnectors := []market.Connector{connector}
	if err := api.overlayConnectorAuthorizationProjections(ctx, projectedConnectors); err != nil {
		payload, _ := connectorMarketError(err)
		return tuttigenerated.GetConnectorMarketConnector503JSONResponse{ConnectorMarketUnavailableErrorJSONResponse: unavailableConnectorMarketResponse(payload)}, nil
	}
	connector = projectedConnectors[0]
	projected, err := projectConnectorMarket[tuttigenerated.ConnectorMarketConnector](connector)
	if err != nil {
		return nil, err
	}
	return tuttigenerated.GetConnectorMarketConnector200JSONResponse(projected), nil
}

func (api DaemonAPI) RefreshConnectorMarket(
	ctx context.Context,
	request tuttigenerated.RefreshConnectorMarketRequestObject,
) (tuttigenerated.RefreshConnectorMarketResponseObject, error) {
	if api.ConnectorMarketService == nil {
		return tuttigenerated.RefreshConnectorMarket503JSONResponse{ConnectorMarketUnavailableErrorJSONResponse: connectorMarketUnavailableError()}, nil
	}
	mutation, err := connectorMarketMutation(request.Body)
	if err != nil {
		return tuttigenerated.RefreshConnectorMarket400JSONResponse{ConnectorMarketInvalidRequestErrorJSONResponse: invalidConnectorMarketResponse(connectorMarketErrorPayload(err))}, nil
	}
	mutation.Scope = market.OperationScope{AccountID: api.connectorMarketAccountID()}
	result, err := api.ConnectorMarketService.RefreshCatalog(ctx, mutation)
	if err != nil {
		payload, status := connectorMarketError(err)
		if status == 409 {
			return tuttigenerated.RefreshConnectorMarket409JSONResponse{ConnectorMarketConflictErrorJSONResponse: conflictConnectorMarketResponse(payload)}, nil
		}
		if status == 400 {
			return tuttigenerated.RefreshConnectorMarket400JSONResponse{ConnectorMarketInvalidRequestErrorJSONResponse: invalidConnectorMarketResponse(payload)}, nil
		}
		return tuttigenerated.RefreshConnectorMarket503JSONResponse{ConnectorMarketUnavailableErrorJSONResponse: unavailableConnectorMarketResponse(payload)}, nil
	}
	projected, err := projectConnectorMarket[tuttigenerated.ConnectorMarketMutationResponse](result)
	if err != nil {
		return nil, err
	}
	return tuttigenerated.RefreshConnectorMarket202JSONResponse(projected), nil
}

func (api DaemonAPI) InstallConnectorMarketConnector(
	ctx context.Context,
	request tuttigenerated.InstallConnectorMarketConnectorRequestObject,
) (tuttigenerated.InstallConnectorMarketConnectorResponseObject, error) {
	if api.ConnectorMarketService == nil {
		return tuttigenerated.InstallConnectorMarketConnector503JSONResponse{ConnectorMarketUnavailableErrorJSONResponse: connectorMarketUnavailableError()}, nil
	}
	mutation, err := connectorMarketConnectorMutation(request.ConnectorKey, request.Body)
	if err != nil {
		return tuttigenerated.InstallConnectorMarketConnector400JSONResponse{ConnectorMarketInvalidRequestErrorJSONResponse: invalidConnectorMarketResponse(connectorMarketErrorPayload(err))}, nil
	}
	mutation.AccountID = api.connectorMarketAccountID()
	result, err := api.ConnectorMarketService.Install(ctx, mutation)
	if err != nil {
		payload, status := connectorMarketError(err)
		switch status {
		case 400:
			return tuttigenerated.InstallConnectorMarketConnector400JSONResponse{ConnectorMarketInvalidRequestErrorJSONResponse: invalidConnectorMarketResponse(payload)}, nil
		case 404:
			return tuttigenerated.InstallConnectorMarketConnector404JSONResponse{ConnectorMarketNotFoundErrorJSONResponse: notFoundConnectorMarketResponse(payload)}, nil
		case 409:
			return tuttigenerated.InstallConnectorMarketConnector409JSONResponse{ConnectorMarketConflictErrorJSONResponse: conflictConnectorMarketResponse(payload)}, nil
		case 422:
			return tuttigenerated.InstallConnectorMarketConnector422JSONResponse{ConnectorMarketUnprocessableErrorJSONResponse: unprocessableConnectorMarketResponse(payload)}, nil
		default:
			return tuttigenerated.InstallConnectorMarketConnector503JSONResponse{ConnectorMarketUnavailableErrorJSONResponse: unavailableConnectorMarketResponse(payload)}, nil
		}
	}
	projected, err := projectConnectorMarket[tuttigenerated.ConnectorMarketMutationResponse](result)
	if err != nil {
		return nil, err
	}
	return tuttigenerated.InstallConnectorMarketConnector202JSONResponse(projected), nil
}

func (api DaemonAPI) UninstallConnectorMarketConnector(
	ctx context.Context,
	request tuttigenerated.UninstallConnectorMarketConnectorRequestObject,
) (tuttigenerated.UninstallConnectorMarketConnectorResponseObject, error) {
	if api.ConnectorMarketService == nil {
		return tuttigenerated.UninstallConnectorMarketConnector503JSONResponse{ConnectorMarketUnavailableErrorJSONResponse: connectorMarketUnavailableError()}, nil
	}
	mutation, err := connectorMarketConnectorMutation(request.ConnectorKey, request.Body)
	if err != nil {
		return tuttigenerated.UninstallConnectorMarketConnector400JSONResponse{ConnectorMarketInvalidRequestErrorJSONResponse: invalidConnectorMarketResponse(connectorMarketErrorPayload(err))}, nil
	}
	mutation.AccountID = api.connectorMarketAccountID()
	result, err := api.ConnectorMarketService.Uninstall(ctx, mutation)
	if err != nil {
		payload, status := connectorMarketError(err)
		switch status {
		case 400:
			return tuttigenerated.UninstallConnectorMarketConnector400JSONResponse{ConnectorMarketInvalidRequestErrorJSONResponse: invalidConnectorMarketResponse(payload)}, nil
		case 404:
			return tuttigenerated.UninstallConnectorMarketConnector404JSONResponse{ConnectorMarketNotFoundErrorJSONResponse: notFoundConnectorMarketResponse(payload)}, nil
		case 409:
			return tuttigenerated.UninstallConnectorMarketConnector409JSONResponse{ConnectorMarketConflictErrorJSONResponse: conflictConnectorMarketResponse(payload)}, nil
		default:
			return tuttigenerated.UninstallConnectorMarketConnector503JSONResponse{ConnectorMarketUnavailableErrorJSONResponse: unavailableConnectorMarketResponse(payload)}, nil
		}
	}
	projected, err := projectConnectorMarket[tuttigenerated.ConnectorMarketMutationResponse](result)
	if err != nil {
		return nil, err
	}
	return tuttigenerated.UninstallConnectorMarketConnector202JSONResponse(projected), nil
}

func (api DaemonAPI) StartConnectorMarketAuthorization(
	ctx context.Context,
	request tuttigenerated.StartConnectorMarketAuthorizationRequestObject,
) (tuttigenerated.StartConnectorMarketAuthorizationResponseObject, error) {
	if api.ConnectorMarketService == nil {
		return tuttigenerated.StartConnectorMarketAuthorization503JSONResponse{ConnectorMarketUnavailableErrorJSONResponse: connectorMarketUnavailableError()}, nil
	}
	mutation, secret, err := connectorMarketAuthorizationMutation(request.ConnectorKey, request.Body)
	if err != nil {
		return tuttigenerated.StartConnectorMarketAuthorization400JSONResponse{ConnectorMarketInvalidRequestErrorJSONResponse: invalidConnectorMarketResponse(connectorMarketErrorPayload(err))}, nil
	}
	mutation.AccountID = api.connectorMarketAccountID()
	defer clear(secret)
	result, err := api.ConnectorMarketService.BeginAuthorization(ctx, mutation, secret)
	if err != nil {
		payload, status := connectorMarketError(err)
		switch status {
		case 400:
			return tuttigenerated.StartConnectorMarketAuthorization400JSONResponse{ConnectorMarketInvalidRequestErrorJSONResponse: invalidConnectorMarketResponse(payload)}, nil
		case 404:
			return tuttigenerated.StartConnectorMarketAuthorization404JSONResponse{ConnectorMarketNotFoundErrorJSONResponse: notFoundConnectorMarketResponse(payload)}, nil
		case 409:
			return tuttigenerated.StartConnectorMarketAuthorization409JSONResponse{ConnectorMarketConflictErrorJSONResponse: conflictConnectorMarketResponse(payload)}, nil
		default:
			return tuttigenerated.StartConnectorMarketAuthorization503JSONResponse{ConnectorMarketUnavailableErrorJSONResponse: unavailableConnectorMarketResponse(payload)}, nil
		}
	}
	projected, err := projectConnectorMarket[tuttigenerated.ConnectorMarketAuthorizationResponse](result)
	if err != nil {
		return nil, err
	}
	return tuttigenerated.StartConnectorMarketAuthorization200JSONResponse(projected), nil
}

func (api DaemonAPI) CancelConnectorMarketAuthorization(
	ctx context.Context,
	request tuttigenerated.CancelConnectorMarketAuthorizationRequestObject,
) (tuttigenerated.CancelConnectorMarketAuthorizationResponseObject, error) {
	if api.ConnectorMarketService == nil {
		return tuttigenerated.CancelConnectorMarketAuthorization503JSONResponse{ConnectorMarketUnavailableErrorJSONResponse: connectorMarketUnavailableError()}, nil
	}
	err := api.ConnectorMarketService.CancelAuthorization(ctx, market.OperationScope{
		AccountID: api.connectorMarketAccountID(),
	}, string(request.ConnectorKey))
	if err != nil {
		payload, status := connectorMarketError(err)
		if status == 404 {
			return tuttigenerated.CancelConnectorMarketAuthorization404JSONResponse{ConnectorMarketNotFoundErrorJSONResponse: notFoundConnectorMarketResponse(payload)}, nil
		}
		return tuttigenerated.CancelConnectorMarketAuthorization503JSONResponse{ConnectorMarketUnavailableErrorJSONResponse: unavailableConnectorMarketResponse(payload)}, nil
	}
	return tuttigenerated.CancelConnectorMarketAuthorization204Response{}, nil
}

func (api DaemonAPI) DisconnectConnectorMarketAuthorization(
	ctx context.Context,
	request tuttigenerated.DisconnectConnectorMarketAuthorizationRequestObject,
) (tuttigenerated.DisconnectConnectorMarketAuthorizationResponseObject, error) {
	if api.ConnectorMarketService == nil {
		return tuttigenerated.DisconnectConnectorMarketAuthorization503JSONResponse{ConnectorMarketUnavailableErrorJSONResponse: connectorMarketUnavailableError()}, nil
	}
	mutation, err := connectorMarketConnectorMutation(request.ConnectorKey, request.Body)
	if err != nil {
		return tuttigenerated.DisconnectConnectorMarketAuthorization400JSONResponse{ConnectorMarketInvalidRequestErrorJSONResponse: invalidConnectorMarketResponse(connectorMarketErrorPayload(err))}, nil
	}
	mutation.AccountID = api.connectorMarketAccountID()
	result, err := api.ConnectorMarketService.DisconnectAuthorization(ctx, mutation)
	if err != nil {
		payload, status := connectorMarketError(err)
		switch status {
		case 400:
			return tuttigenerated.DisconnectConnectorMarketAuthorization400JSONResponse{ConnectorMarketInvalidRequestErrorJSONResponse: invalidConnectorMarketResponse(payload)}, nil
		case 404:
			return tuttigenerated.DisconnectConnectorMarketAuthorization404JSONResponse{ConnectorMarketNotFoundErrorJSONResponse: notFoundConnectorMarketResponse(payload)}, nil
		case 409:
			return tuttigenerated.DisconnectConnectorMarketAuthorization409JSONResponse{ConnectorMarketConflictErrorJSONResponse: conflictConnectorMarketResponse(payload)}, nil
		default:
			return tuttigenerated.DisconnectConnectorMarketAuthorization503JSONResponse{ConnectorMarketUnavailableErrorJSONResponse: unavailableConnectorMarketResponse(payload)}, nil
		}
	}
	projected, err := projectConnectorMarket[tuttigenerated.ConnectorMarketMutationResponse](result)
	if err != nil {
		return nil, err
	}
	return tuttigenerated.DisconnectConnectorMarketAuthorization202JSONResponse(projected), nil
}

func (api DaemonAPI) GetConnectorMarketOperation(
	ctx context.Context,
	request tuttigenerated.GetConnectorMarketOperationRequestObject,
) (tuttigenerated.GetConnectorMarketOperationResponseObject, error) {
	if api.ConnectorMarketService == nil {
		return tuttigenerated.GetConnectorMarketOperation503JSONResponse{ConnectorMarketUnavailableErrorJSONResponse: connectorMarketUnavailableError()}, nil
	}
	operation, err := api.ConnectorMarketService.GetOperationForScope(
		ctx,
		market.OperationScope{AccountID: api.connectorMarketAccountID()},
		request.OperationID,
	)
	if err != nil {
		payload, status := connectorMarketError(err)
		switch status {
		case 400:
			return tuttigenerated.GetConnectorMarketOperation400JSONResponse{ConnectorMarketInvalidRequestErrorJSONResponse: invalidConnectorMarketResponse(payload)}, nil
		case 404:
			return tuttigenerated.GetConnectorMarketOperation404JSONResponse{ConnectorMarketNotFoundErrorJSONResponse: notFoundConnectorMarketResponse(payload)}, nil
		default:
			return tuttigenerated.GetConnectorMarketOperation503JSONResponse{ConnectorMarketUnavailableErrorJSONResponse: unavailableConnectorMarketResponse(payload)}, nil
		}
	}
	projected, err := projectConnectorMarket[tuttigenerated.ConnectorMarketOperation](operation)
	if err != nil {
		return nil, err
	}
	return tuttigenerated.GetConnectorMarketOperation200JSONResponse(projected), nil
}

func connectorMarketMutation(body *tuttigenerated.ConnectorMarketMutationRequest) (market.Mutation, error) {
	if body == nil || body.ExpectedRevision < 0 {
		return market.Mutation{}, invalidConnectorMarketRequest()
	}
	return market.Mutation{ClientRequestID: body.ClientRequestId, ExpectedRevision: uint64(body.ExpectedRevision)}, nil
}

func connectorMarketConnectorMutation(
	connectorKey string,
	body *tuttigenerated.ConnectorMarketMutationRequest,
) (market.ConnectorMutation, error) {
	mutation, err := connectorMarketMutation(body)
	if err != nil {
		return market.ConnectorMutation{}, err
	}
	if body.ExpectedConnectorRevision != nil && *body.ExpectedConnectorRevision < 0 {
		return market.ConnectorMutation{}, invalidConnectorMarketRequest()
	}
	result := market.ConnectorMutation{Mutation: mutation, ConnectorKey: connectorKey}
	if body.ExpectedConnectorRevision != nil {
		revision := uint64(*body.ExpectedConnectorRevision)
		result.ExpectedConnectorRevision = &revision
	}
	return result, nil
}

func connectorMarketAuthorizationMutation(
	connectorKey string,
	body *tuttigenerated.ConnectorMarketAuthorizationRequest,
) (market.ConnectorMutation, []byte, error) {
	if body == nil || body.ExpectedRevision < 0 ||
		(body.ExpectedConnectorRevision != nil && *body.ExpectedConnectorRevision < 0) {
		return market.ConnectorMutation{}, nil, invalidConnectorMarketRequest()
	}
	var secret []byte
	if body.Secret != nil {
		secret = []byte(*body.Secret)
		if len(secret) == 0 || len(secret) > 16384 {
			clear(secret)
			return market.ConnectorMutation{}, nil, invalidConnectorMarketRequest()
		}
	}
	result := market.ConnectorMutation{
		Mutation:     market.Mutation{ClientRequestID: body.ClientRequestId, ExpectedRevision: uint64(body.ExpectedRevision)},
		ConnectorKey: connectorKey,
	}
	if body.ExpectedConnectorRevision != nil {
		revision := uint64(*body.ExpectedConnectorRevision)
		result.ExpectedConnectorRevision = &revision
	}
	return result, secret, nil
}

func invalidConnectorMarketRequest() error {
	return market.NewDomainError(market.ErrorCodeInvalidRequest, "connector market request is invalid", false, nil)
}

func (api DaemonAPI) connectorMarketAccountID() string {
	if api.ConnectorMarketScope == nil {
		return ""
	}
	return api.ConnectorMarketScope().AccountID
}

func (api DaemonAPI) overlayConnectorAuthorizationProjections(ctx context.Context, connectors []market.Connector) error {
	accountID := api.connectorMarketAccountID()
	if accountID == "" || api.ConnectorMarketService == nil {
		return nil
	}
	for index := range connectors {
		connector := &connectors[index]
		if connector.Release.Manifest.AuthorizationKind == "none" {
			connector.Authorization = market.Authorization{State: market.AuthorizationStateNotRequired}
			continue
		}
		projection, err := api.ConnectorMarketService.GetAuthorizationProjection(ctx, accountID, connector.Key)
		if errors.Is(err, market.ErrNotFound) {
			connector.Authorization = market.Authorization{State: market.AuthorizationStateDisconnected}
			continue
		}
		if err != nil {
			return err
		}
		if connector.Release.Manifest.Implementation.RemoteStreamableHTTP != nil &&
			(!projection.ServerSynchronized || api.ConnectorAuthorizationReady != nil && !api.ConnectorAuthorizationReady(accountID)) {
			connector.Authorization = market.Authorization{State: market.AuthorizationStateDisconnected}
			continue
		}
		connector.Authorization = market.Authorization{State: projection.State, FailureCode: projection.FailureCode}
	}
	return nil
}

func projectConnectorMarket[T any](value any) (T, error) {
	var projected T
	value = exposeConnectorMarketAuthorizationInteractionMode(value)
	payload, err := json.Marshal(value)
	if err != nil {
		return projected, err
	}
	if err := json.Unmarshal(payload, &projected); err != nil {
		return projected, err
	}
	return projected, nil
}

func exposeConnectorMarketAuthorizationInteractionMode(value any) any {
	switch typed := value.(type) {
	case market.Snapshot:
		typed.Connectors = append([]market.Connector{}, typed.Connectors...)
		for index := range typed.Connectors {
			typed.Connectors[index] = exposeConnectorAuthorizationInteractionMode(typed.Connectors[index])
		}
		return typed
	case market.CatalogPage:
		typed.Items = append([]market.CatalogListing{}, typed.Items...)
		for index := range typed.Items {
			typed.Items[index].Connector = exposeConnectorAuthorizationInteractionMode(typed.Items[index].Connector)
		}
		return typed
	case market.Connector:
		return exposeConnectorAuthorizationInteractionMode(typed)
	case market.MutationResult:
		if typed.Connector != nil {
			connector := exposeConnectorAuthorizationInteractionMode(*typed.Connector)
			typed.Connector = &connector
		}
		return typed
	case market.AuthorizationResult:
		typed.Connector = exposeConnectorAuthorizationInteractionMode(typed.Connector)
		return typed
	default:
		return value
	}
}

func exposeConnectorAuthorizationInteractionMode(connector market.Connector) market.Connector {
	managed := connector.Release.Manifest.Implementation.ManagedStdio
	if managed != nil && managed.CredentialBroker != nil {
		connector.Release.Manifest.AuthorizationInteractionMode = market.AuthorizationInteractionModeManaged
	}
	return connector
}

func connectorMarketGetSnapshotError(err error) tuttigenerated.GetConnectorMarketResponseObject {
	payload, status := connectorMarketError(err)
	if status == 400 {
		return tuttigenerated.GetConnectorMarket400JSONResponse{ConnectorMarketInvalidRequestErrorJSONResponse: invalidConnectorMarketResponse(payload)}
	}
	return tuttigenerated.GetConnectorMarket503JSONResponse{ConnectorMarketUnavailableErrorJSONResponse: unavailableConnectorMarketResponse(payload)}
}

func connectorMarketError(err error) (tuttigenerated.ConnectorMarketError, int) {
	payload := connectorMarketErrorPayload(err)
	if errors.Is(err, market.ErrNotFound) {
		payload.Code = tuttigenerated.ConnectorNotFound
		payload.Message = "connector market resource was not found"
		return payload, 404
	}
	var domainError *market.DomainError
	if !errors.As(err, &domainError) {
		return payload, 503
	}
	switch domainError.Code {
	case market.ErrorCodeInvalidRequest:
		return payload, 400
	case market.ErrorCodeNotFound:
		return payload, 404
	case market.ErrorCodeRevisionConflict, market.ErrorCodeOperationInProgress:
		return payload, 409
	case market.ErrorCodeIncompatible, market.ErrorCodeInvalidManifest, market.ErrorCodeUnsupportedImplementation:
		return payload, 422
	default:
		return payload, 503
	}
}

func connectorMarketErrorPayload(err error) tuttigenerated.ConnectorMarketError {
	result := tuttigenerated.ConnectorMarketError{
		Code:      tuttigenerated.ConnectorMarketUnavailable,
		Message:   "connector market is temporarily unavailable",
		Retryable: true,
	}
	var domainError *market.DomainError
	if errors.As(err, &domainError) {
		result.Code = tuttigenerated.ConnectorMarketErrorCode(domainError.Code)
		result.Message = domainError.Message
		result.Retryable = domainError.Retryable
	}
	return result
}

func connectorMarketUnavailableError() tuttigenerated.ConnectorMarketUnavailableErrorJSONResponse {
	return unavailableConnectorMarketResponse(tuttigenerated.ConnectorMarketError{
		Code: tuttigenerated.ConnectorMarketUnavailable, Message: "connector market is unavailable", Retryable: true,
	})
}

func invalidConnectorMarketResponse(payload tuttigenerated.ConnectorMarketError) tuttigenerated.ConnectorMarketInvalidRequestErrorJSONResponse {
	return tuttigenerated.ConnectorMarketInvalidRequestErrorJSONResponse(payload)
}

func notFoundConnectorMarketResponse(payload tuttigenerated.ConnectorMarketError) tuttigenerated.ConnectorMarketNotFoundErrorJSONResponse {
	return tuttigenerated.ConnectorMarketNotFoundErrorJSONResponse(payload)
}

func conflictConnectorMarketResponse(payload tuttigenerated.ConnectorMarketError) tuttigenerated.ConnectorMarketConflictErrorJSONResponse {
	return tuttigenerated.ConnectorMarketConflictErrorJSONResponse(payload)
}

func unprocessableConnectorMarketResponse(payload tuttigenerated.ConnectorMarketError) tuttigenerated.ConnectorMarketUnprocessableErrorJSONResponse {
	return tuttigenerated.ConnectorMarketUnprocessableErrorJSONResponse(payload)
}

func unavailableConnectorMarketResponse(payload tuttigenerated.ConnectorMarketError) tuttigenerated.ConnectorMarketUnavailableErrorJSONResponse {
	return tuttigenerated.ConnectorMarketUnavailableErrorJSONResponse(payload)
}
