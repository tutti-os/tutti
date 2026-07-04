module github.com/tutti-os/tutti/services/tuttid

go 1.24.3

toolchain go1.24.5

require (
	github.com/coder/websocket v1.8.14
	github.com/creack/pty v1.1.24
	github.com/google/uuid v1.6.0
	github.com/oapi-codegen/runtime v1.4.1
	github.com/tutti-os/tutti/packages/agentactivity/daemon v0.0.0
	github.com/tutti-os/tutti/packages/appcli/core v0.0.0
	github.com/tutti-os/tutti/packages/auth/bridge-go v0.0.0
	github.com/tutti-os/tutti/packages/events/stream-go v0.0.0
	github.com/tutti-os/tutti/packages/workbench/service v0.0.0
	github.com/tutti-os/tutti/packages/workspace/files v0.0.0
	github.com/tutti-os/tutti/packages/workspace/issues v0.0.0
	github.com/volcengine/datarangers-sdk-go v1.1.8
	golang.org/x/sys v0.41.0
	modernc.org/sqlite v1.45.0
)

replace github.com/tutti-os/tutti/packages/events/stream-go => ../../packages/events/stream-go

replace github.com/tutti-os/tutti/packages/workbench/service => ../../packages/workbench/service

replace github.com/tutti-os/tutti/packages/agentactivity/daemon => ../../packages/agent/daemon

replace github.com/tutti-os/tutti/packages/workspace/files => ../../packages/workspace/files

replace github.com/tutti-os/tutti/packages/workspace/issues => ../../packages/workspace/issues

require (
	github.com/Shopify/sarama v1.34.1 // indirect
	github.com/apapsch/go-jsonmerge/v2 v2.0.0 // indirect
	github.com/davecgh/go-spew v1.1.2-0.20180830191138-d8f796af33cc // indirect
	github.com/dprotaso/go-yit v0.0.0-20220510233725-9ba8df137936 // indirect
	github.com/dustin/go-humanize v1.0.1 // indirect
	github.com/eapache/go-resiliency v1.2.0 // indirect
	github.com/eapache/go-xerial-snappy v0.0.0-20180814174437-776d5712da21 // indirect
	github.com/eapache/queue v1.1.0 // indirect
	github.com/getkin/kin-openapi v0.135.0 // indirect
	github.com/go-openapi/jsonpointer v0.22.4 // indirect
	github.com/go-openapi/swag/jsonname v0.25.4 // indirect
	github.com/golang/snappy v0.0.4 // indirect
	github.com/google/go-cmp v0.7.0 // indirect
	github.com/hashicorp/errwrap v1.0.0 // indirect
	github.com/hashicorp/go-multierror v1.1.1 // indirect
	github.com/hashicorp/go-uuid v1.0.2 // indirect
	github.com/jcmturner/aescts/v2 v2.0.0 // indirect
	github.com/jcmturner/dnsutils/v2 v2.0.0 // indirect
	github.com/jcmturner/gofork v1.0.0 // indirect
	github.com/jcmturner/gokrb5/v8 v8.4.2 // indirect
	github.com/jcmturner/rpc/v2 v2.0.3 // indirect
	github.com/josharian/intern v1.0.0 // indirect
	github.com/klauspost/compress v1.17.7 // indirect
	github.com/mailru/easyjson v0.9.1 // indirect
	github.com/mattn/go-isatty v0.0.20 // indirect
	github.com/mohae/deepcopy v0.0.0-20170929034955-c48cc78d4826 // indirect
	github.com/ncruces/go-strftime v1.0.0 // indirect
	github.com/oapi-codegen/oapi-codegen/v2 v2.7.0 // indirect
	github.com/oasdiff/yaml v0.0.9 // indirect
	github.com/oasdiff/yaml3 v0.0.9 // indirect
	github.com/perimeterx/marshmallow v1.1.5 // indirect
	github.com/pierrec/lz4/v4 v4.1.18 // indirect
	github.com/rcrowley/go-metrics v0.0.0-20201227073835-cf1acfcdf475 // indirect
	github.com/remyoudompheng/bigfft v0.0.0-20230129092748-24d4a6f8daec // indirect
	github.com/rogpeppe/go-internal v1.14.1 // indirect
	github.com/speakeasy-api/jsonpath v0.6.3 // indirect
	github.com/speakeasy-api/openapi v1.19.2 // indirect
	github.com/vmware-labs/yaml-jsonpath v0.3.2 // indirect
	github.com/woodsbury/decimal128 v1.4.0 // indirect
	go.uber.org/atomic v1.7.0 // indirect
	go.uber.org/multierr v1.6.0 // indirect
	go.uber.org/zap v1.16.0 // indirect
	go.yaml.in/yaml/v3 v3.0.4 // indirect
	golang.org/x/crypto v0.48.0 // indirect
	golang.org/x/exp v0.0.0-20251023183803-a4bb9ffd2546 // indirect
	golang.org/x/mod v0.33.0 // indirect
	golang.org/x/net v0.50.0 // indirect
	golang.org/x/sync v0.19.0 // indirect
	golang.org/x/text v0.34.0 // indirect
	golang.org/x/tools v0.42.0 // indirect
	gopkg.in/natefinch/lumberjack.v2 v2.0.0 // indirect
	gopkg.in/yaml.v2 v2.4.0 // indirect
	gopkg.in/yaml.v3 v3.0.1 // indirect
	modernc.org/libc v1.67.6 // indirect
	modernc.org/mathutil v1.7.1 // indirect
	modernc.org/memory v1.11.0 // indirect
)

tool github.com/oapi-codegen/oapi-codegen/v2/cmd/oapi-codegen

replace github.com/tutti-os/tutti/packages/appcli/core => ../../packages/appcli/core

replace github.com/tutti-os/tutti/packages/auth/bridge-go => ../../packages/auth/bridge-go
