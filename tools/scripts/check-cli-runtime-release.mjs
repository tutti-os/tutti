import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const moduleRoot = join(workspaceRoot, "packages", "cli", "runtime");

run("go", ["test", "./..."], moduleRoot);
run("go", ["build", "./..."], moduleRoot);
run("go", ["mod", "tidy", "-diff"], moduleRoot);

const packageInfo = JSON.parse(
  execFileSync("go", ["list", "-json", "."], {
    cwd: moduleRoot,
    encoding: "utf8"
  })
);
const embeddedFiles = new Set(packageInfo.EmbedFiles ?? []);
for (const file of [
  "contract/canonical_manifest.json",
  "testvectors/argv.json",
  "testvectors/domain_scenarios.json",
  "testvectors/gates.json",
  "testvectors/http.json",
  "testvectors/manifest.json",
  "testvectors/render.json"
]) {
  if (!embeddedFiles.has(file)) {
    throw new Error(`CLI runtime release is missing embedded asset ${file}`);
  }
}

const consumerDirectory = mkdtempSync(
  join(tmpdir(), "tutti-cli-runtime-consumer-")
);
try {
  writeFileSync(
    join(consumerDirectory, "go.mod"),
    `module example.com/tutti-cli-runtime-consumer\n\ngo 1.24.3\n\nrequire github.com/tutti-os/tutti/packages/cli/runtime v0.0.0\n\nreplace github.com/tutti-os/tutti/packages/cli/runtime => ${moduleRoot}\n`
  );
  writeFileSync(
    join(consumerDirectory, "runtime_test.go"),
    `package consumer\n\nimport (\n  "testing"\n  cliruntime "github.com/tutti-os/tutti/packages/cli/runtime"\n)\n\nfunc TestPublishedAssets(t *testing.T) {\n  manifest, err := cliruntime.LoadCanonicalManifest()\n  if err != nil { t.Fatal(err) }\n  if len(manifest.Commands) != 55 { t.Fatalf("commands = %d", len(manifest.Commands)) }\n  if _, err := cliruntime.LoadArgvVectors(); err != nil { t.Fatal(err) }\n  if _, err := cliruntime.LoadHTTPVectors(); err != nil { t.Fatal(err) }\n  if _, err := cliruntime.LoadManifestVectors(); err != nil { t.Fatal(err) }\n}\n`
  );
  run("go", ["mod", "vendor"], consumerDirectory);
  for (const file of embeddedFiles) {
    const vendored = join(
      consumerDirectory,
      "vendor",
      "github.com",
      "tutti-os",
      "tutti",
      "packages",
      "cli",
      "runtime",
      file
    );
    if (!existsSync(vendored)) {
      throw new Error(`external consumer is missing vendored asset ${file}`);
    }
  }
  run("go", ["test", "./..."], consumerDirectory);
} finally {
  rmSync(consumerDirectory, { force: true, recursive: true });
}

console.log("CLI runtime release preflight passed");

function run(command, args, cwd) {
  execFileSync(command, args, { cwd, stdio: "inherit" });
}
