import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const sourceDirectory = dirname(dirname(fileURLToPath(import.meta.url)));

test("connector market services do not depend on React", () => {
  const servicesDirectory = join(sourceDirectory, "services");
  const offenders = sourceFiles(servicesDirectory).filter((file) =>
    /(?:from\s+|import\s*\()['"]react(?:\/[^'"]*)?['"]/.test(
      readFileSync(file, "utf8")
    )
  );
  assert.deepEqual(
    offenders.map((file) => relative(sourceDirectory, file)),
    []
  );
});

test("connector market UI does not construct services or import host transports", () => {
  const uiDirectory = join(sourceDirectory, "ui");
  const forbidden = [
    /new\s+ConnectorMarket\w*Service\s*\(/,
    /@tutti-os\/client-tuttid-ts/,
    /window\.(?:tutti|tsh)/,
    /services\/internal\//
  ];
  const offenders = sourceFiles(uiDirectory).filter((file) => {
    const source = readFileSync(file, "utf8");
    return forbidden.some((pattern) => pattern.test(source));
  });
  assert.deepEqual(
    offenders.map((file) => relative(sourceDirectory, file)),
    []
  );
});

test("connector authorization starts only from the explicit dialog action", () => {
  const dialogsSource = readFileSync(
    join(sourceDirectory, "ui", "dialogs", "ConnectorMarketDialogs.tsx"),
    "utf8"
  );

  assert.doesNotMatch(dialogsSource, /autoStartedAuthorization/);
  assert.doesNotMatch(dialogsSource, /brokeredAuthorizationConnectorKey/);
  assert.match(
    dialogsSource,
    /onAuthorize=\{\(secret\)\s*=>\s*authorizeConnector\(dialog\.connectorKey, secret\)/
  );
});

function sourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      files.push(...sourceFiles(path));
    } else if (/\.(?:ts|tsx)$/.test(entry) && !/\.test\./.test(entry)) {
      files.push(path);
    }
  }
  return files;
}
