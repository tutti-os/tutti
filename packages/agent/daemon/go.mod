module github.com/tutti-os/tutti/packages/agent/daemon

go 1.24.3

toolchain go1.24.5

require (
	github.com/atombender/go-jsonschema v0.20.0
	github.com/tutti-os/tutti/packages/agent/host v0.0.212
	github.com/tutti-os/tutti/packages/agent/store-sqlite/canonical v0.0.212
	golang.org/x/net v0.50.0
	google.golang.org/grpc v1.80.0
	google.golang.org/protobuf v1.36.11
)

require (
	dario.cat/mergo v1.0.2 // indirect
	github.com/goccy/go-yaml v1.17.1 // indirect
	github.com/google/go-cmp v0.7.0 // indirect
	github.com/mitchellh/go-wordwrap v1.0.1 // indirect
	github.com/pkg/errors v0.9.1 // indirect
	github.com/sanity-io/litter v1.5.8 // indirect
	github.com/sosodev/duration v1.3.1 // indirect
	golang.org/x/sys v0.41.0 // indirect
	golang.org/x/text v0.34.0 // indirect
	google.golang.org/genproto/googleapis/rpc v0.0.0-20260120221211-b8f7ae30c516 // indirect
)

replace google.golang.org/genproto => google.golang.org/genproto v0.0.0-20260120221211-b8f7ae30c516
