module github.com/tutti-os/tutti/packages/connector/daemon

go 1.24.3

toolchain go1.24.5

require (
	github.com/google/uuid v1.6.0
	github.com/tutti-os/tutti/packages/clients/market-go v0.0.0
	github.com/tutti-os/tutti/packages/connector/host v0.0.0
	github.com/tutti-os/tutti/packages/connector/store-sqlite v0.0.0
	google.golang.org/protobuf v1.36.11
)

require (
	github.com/dustin/go-humanize v1.0.1 // indirect
	github.com/go-kratos/aegis v0.2.0 // indirect
	github.com/go-kratos/kratos/v2 v2.9.2 // indirect
	github.com/go-playground/form/v4 v4.2.0 // indirect
	github.com/gorilla/mux v1.8.1 // indirect
	github.com/mattn/go-isatty v0.0.20 // indirect
	github.com/ncruces/go-strftime v1.0.0 // indirect
	github.com/remyoudompheng/bigfft v0.0.0-20230129092748-24d4a6f8daec // indirect
	golang.org/x/exp v0.0.0-20251023183803-a4bb9ffd2546 // indirect
	golang.org/x/mod v0.33.0 // indirect
	golang.org/x/sync v0.19.0 // indirect
	golang.org/x/sys v0.41.0 // indirect
	google.golang.org/genproto/googleapis/api v0.0.0-20260128011058-8636f8732409 // indirect
	google.golang.org/genproto/googleapis/rpc v0.0.0-20260122232226-8e98ce8d340d // indirect
	google.golang.org/grpc v1.71.0 // indirect
	gopkg.in/yaml.v3 v3.0.1 // indirect
	modernc.org/libc v1.67.6 // indirect
	modernc.org/mathutil v1.7.1 // indirect
	modernc.org/memory v1.11.0 // indirect
	modernc.org/sqlite v1.45.0 // indirect
)

replace github.com/tutti-os/tutti/packages/connector/host => ../host

replace github.com/tutti-os/tutti/packages/connector/store-sqlite => ../store-sqlite

replace github.com/tutti-os/tutti/packages/clients/market-go => ../../clients/market-go
