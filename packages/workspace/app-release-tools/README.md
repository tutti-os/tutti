# @tutti-os/app-release-tools

Command-line tools for publishing Nextop workspace apps into App Center release metadata.

## Commands

```sh
build-nextop-app-release --app-id vibe-design --package-dir dist/nextop-app/vibe-design --base-url https://cdn.example.test/nextop-app-releases
build-nextop-app-catalog --release-file ./apps/vibe-design/latest.json --output ./catalog.json
build-nextop-app-catalog --existing-catalog ./catalog.json --release-file ./apps/vibe-design/latest.json --output ./catalog.json
bump-nextop-app-version --app-id vibe-design --manifest ./nextop.app.json --bump patch
verify-nextop-app-release-artifacts --release-file ./apps/vibe-design/latest.json
verify-nextop-app-release-artifacts --catalog-file ./catalog.json --release-file ./apps/vibe-design/latest.json
```

The release command validates a complete Nextop app package, creates a zip, writes immutable `release.json`, and writes mutable `latest.json`.

The version bump command updates an app manifest from one stable semver version
to the next major, minor, or patch version.

The catalog command merges one or more release files into `nextop.app.catalog.v1`.
Pass `--existing-catalog` to preserve existing catalog apps and update only the
apps represented by the release files. With `--existing-catalog`, release files
are optional, which allows rewriting an existing catalog without changing its app
set.

The verify command checks release and catalog metadata against the referenced
artifact downloads. When both `--catalog-file` and `--release-file` are passed,
catalog entries for those apps must exactly match the latest release metadata
before artifact SHA-256 and size checks run.
