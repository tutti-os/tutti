# @tutti-os/app-release-tools

Command-line tools for publishing Tutti workspace apps into App Center release metadata.

## Commands

```sh
build-tutti-app-release --app-id vibe-design --package-dir dist/tutti-app/vibe-design --base-url https://cdn.example.test/tutti-app-releases
build-tutti-app-versions --release-file ./apps/vibe-design/0.2.0/release.json --min-tutti-version 0.12.0 --output ./apps/vibe-design/versions.json
build-tutti-app-catalog --versions-file ./apps/vibe-design/versions.json --output ./catalog.json
build-tutti-app-catalog --existing-catalog ./catalog.json --versions-file ./apps/vibe-design/versions.json --output ./catalog.json
verify-tutti-app-release-artifacts --release-file ./apps/vibe-design/latest.json
verify-tutti-app-release-artifacts --catalog-file ./catalog.json --versions-file ./apps/vibe-design/versions.json
```

The release command validates a complete Tutti app package, creates a
reproducible zip with stable entry ordering and timestamps, writes immutable
`release.json`, and writes mutable `latest.json`. Rebuilding the same package
version produces the same artifact SHA-256, so an interrupted release can
safely verify and reuse its immutable upload. When the manifest declares
`localizationInfo`, the release metadata includes the referenced manifest
locale files so App Center can localize uninstalled remote apps without
downloading the package.

App CLI manifests may declare `execution.mode: "wait"` for commands that block
until a run or session reaches a stop point. Wait commands use JSON output and
must leave `--timeout-ms` to the Tutti CLI as the optional total wait deadline;
App input schemas must not redefine it.

The versions command maintains one mutable `tutti.app.versions.v1` index per
app. Every catalog-eligible release has an explicit minimum Tutti version and
an `active` or `withdrawn` status. Reusing an immutable app version with changed
release or compatibility metadata is rejected.

The catalog command merges version indexes into `tutti.app.catalog.v1`.
`apps[]` contains the highest active app version whose minimum Tutti version is
`0.0.0`, so old Tutti clients remain safe. `compatibility.apps` contains only
the compact compatibility frontier needed by new Tutti clients, not every
historical release. Catalog output is rejected when it exceeds the legacy 1 MiB
reader limit. The older `--release-file` form remains available for legacy
tooling but does not create compatibility metadata.

The verify command checks release and catalog metadata against the referenced
artifact downloads. When `--catalog-file` is combined with `--release-file` or
`--versions-file`, catalog entries for those apps must exactly match the
corresponding release metadata before artifact SHA-256 and size checks run.

`publish-tutti-app-metadata` and `publish-tutti-app-catalog` update mutable S3
JSON objects with ETag conditional writes and retry on concurrent changes. They
bootstrap a missing versions index from the exact immutable release currently
present in the legacy catalog; they never infer legacy compatibility from a
newer `latest.json` object. Catalog publication validates all metadata and
downloads referenced artifacts before attempting the conditional S3 write.
