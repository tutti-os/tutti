import { copyFile, mkdir, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const sourceRoot = join(packageRoot, "src");
const outputRoot = join(packageRoot, "dist");
const sessionReplayRoot = join(packageRoot, "..", "session-replay");

await rm(outputRoot, { force: true, recursive: true });
await mkdir(outputRoot, { recursive: true });

for (const entry of await readdir(sourceRoot, { withFileTypes: true })) {
  if (
    entry.isFile() &&
    entry.name.endsWith(".mjs") &&
    !entry.name.endsWith(".test.mjs")
  ) {
    await copyFile(join(sourceRoot, entry.name), join(outputRoot, entry.name));
  }
}

for (const contract of ["activity-contract.json", "cassette-policy.json"]) {
  await copyFile(join(sessionReplayRoot, contract), join(outputRoot, contract));
}
