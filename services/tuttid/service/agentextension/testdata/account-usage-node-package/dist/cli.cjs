#!/usr/bin/env node

if (process.argv.slice(2).join(" ") !== "--output json") {
  process.exitCode = 2;
} else {
  process.stdout.write(
    JSON.stringify({
      schemaVersion: "tutti.agent.account-usage.v1",
      outcome: "available",
      capturedAtUnixMs: 1,
      billingMode: "api",
      quotas: []
    })
  );
}
