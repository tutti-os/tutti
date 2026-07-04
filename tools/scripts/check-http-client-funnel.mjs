// Guards the outbound-HTTP funnel: Go code must build clients through
// packages/agent/daemon/httpx (proxy-aware) instead of bare http.Client
// literals, which silently bypass the user's proxy configuration. forbidigo
// already rejects http.DefaultClient and http.Get/Post/...; this script covers
// the composite-literal case forbidigo cannot express.
//
// Exemptions: the httpx package itself, _test.go files, and lines carrying a
// `proxy-funnel-exempt: <reason>` comment.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const scanRoots = ["services/tuttid", "packages/agent"];
const clientLiteral = /\bhttp\.Client\{/;
const exemptComment = "proxy-funnel-exempt:";
const exemptPathFragments = ["packages/agent/daemon/httpx/"];

function* goFiles(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) {
      continue;
    }
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      yield* goFiles(path);
    } else if (entry.name.endsWith(".go") && !entry.name.endsWith("_test.go")) {
      yield path;
    }
  }
}

const violations = [];
for (const root of scanRoots) {
  for (const path of goFiles(join(workspaceRoot, root))) {
    const relativePath = relative(workspaceRoot, path);
    if (
      exemptPathFragments.some((fragment) => relativePath.includes(fragment))
    ) {
      continue;
    }
    const lines = readFileSync(path, "utf8").split("\n");
    lines.forEach((line, index) => {
      if (clientLiteral.test(line) && !line.includes(exemptComment)) {
        violations.push(`${relativePath}:${index + 1}: ${line.trim()}`);
      }
    });
  }
}

if (violations.length > 0) {
  console.error(
    "Bare http.Client literals bypass the proxy funnel. Use packages/agent/daemon/httpx" +
      " (NewClient/NewTransport/Default), or append `// proxy-funnel-exempt: <reason>`:\n"
  );
  for (const violation of violations) {
    console.error(`  ${violation}`);
  }
  process.exit(1);
}
