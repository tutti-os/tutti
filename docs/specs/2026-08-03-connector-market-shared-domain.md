# Connector Market Shared Domain

Status: accepted architecture, implementation in progress.

## Goal

Make Tutti the source repository for one connector-market capability that runs
inside both tuttidd and the TSH desktop daemon. Both hosts share domain
semantics and HTTP contracts while keeping independent local state and
product-specific adapters.

## Target shape

`packages/connector/market` publishes a Go module and npm package in the shared
package release cohort. It owns the OpenAPI fragment, Go domain boundary, and
Valtio renderer domain service. Each host composes the fragment, generates its
own transport, implements daemon ports, and injects a renderer backend adapter.

The renderer never reaches an upstream catalog and the public package never
constructs a host HTTP client. The local daemon is the authoritative source for
accepted catalog data, installation state, authorization state, workspace
bindings, and durable operations.

## Delivery sequence

1. Establish and validate the public Go, OpenAPI, and TypeScript contracts.
2. Implement the Go application service and conformance suite.
3. Implement tuttidd persistence, catalog, installer, authorization, event,
   transport, and generated-client adapters.
4. Integrate the Tutti renderer and UI through the generated client adapter.
5. Publish one exact package release cohort.
6. Install the exact Go and npm versions in TSH, compose the same OpenAPI
   fragment, and implement TSH host adapters.
7. Retire the legacy market route after compatibility validation.

TSH may temporarily adapt its existing `tsh-server -> zk-admin-server` market
chain behind `CatalogSource`. That compatibility adapter must not leak into the
shared renderer contract or become the target architecture.

## Current implementation checkpoint

The first checkpoint includes:

- public package and release registration
- shared domain types, state transitions, manifest validation, ports, and an
  application service that owns revision fencing, request idempotency,
  per-connector operation exclusion, durable operation execution, and recovery
- shared OpenAPI fragment
- package-resolved OpenAPI fragment support for cross-repository hosts
- Valtio service with invalidation re-reads, stale-response fencing,
  single-flight refresh, per-connector mutation locks, workspace switching, and
  the class/interface/dataStore/start/dispose renderer-service convention used
  by TSH Room Chat

The fragment is not added to the tuttidd aggregate until the daemon service,
persistence, and handlers exist. This avoids publishing generated routes that
return placeholder responses.
