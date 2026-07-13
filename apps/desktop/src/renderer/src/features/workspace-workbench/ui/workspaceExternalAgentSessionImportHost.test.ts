import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Fusion Settings opens the shared external Agent import wizard host", async () => {
  const [hostSource, standaloneSource] = await Promise.all([
    readFile(
      new URL(
        "./useWorkspaceExternalAgentSessionImportHost.tsx",
        import.meta.url
      ),
      "utf8"
    ),
    readFile(
      new URL("./StandaloneWorkbenchNodeWindow.tsx", import.meta.url),
      "utf8"
    )
  ]);

  assert.match(hostSource, /setOpen\(true\)/);
  assert.match(hostSource, /<ExternalAgentSessionImportWizard/);
  assert.match(
    standaloneSource,
    /onOpenExternalAgentImport=\{openExternalAgentImport\}/
  );
  assert.match(standaloneSource, /\{externalAgentImportHost\}/);
  assert.doesNotMatch(
    standaloneSource,
    /onOpenExternalAgentImport=\{\(\) => undefined\}/
  );
});
