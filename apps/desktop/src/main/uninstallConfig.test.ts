import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Windows uninstall removes only marker-owned CLI shims and preserves user state", async () => {
  const packageJson = JSON.parse(
    await readFile(new URL("../../package.json", import.meta.url), "utf8"),
  ) as {
    build?: { nsis?: { include?: string; deleteAppDataOnUninstall?: boolean } };
  };
  assert.equal(packageJson.build?.nsis?.include, "build/installer.nsh");
  assert.equal(packageJson.build?.nsis?.deleteAppDataOnUninstall, false);

  const include = await readFile(
    new URL("../../build/installer.nsh", import.meta.url),
    "utf8",
  );
  assert.match(include, /rem Tutti CLI shim/);
  assert.match(
    include,
    /!ifdef BUILD_UNINSTALLER[\s\S]*Function un\.RemoveOwnedTuttiShim[\s\S]*FunctionEnd[\s\S]*!endif/,
  );
  assert.match(include, /\$PROFILE\\\.tutti\\bin\\tutti\.cmd/);
  assert.match(include, /\$PROFILE\\\.local\\bin\\tutti\.cmd/);
  assert.match(include, /\$PROFILE\\bin\\tutti\.cmd/);
  assert.match(include, /MessageBox MB_YESNOCANCEL\|MB_ICONQUESTION/);
  assert.match(include, /RMDir \/r "\$PROFILE\\\.tutti"/);
  assert.match(include, /RMDir \/r "\$APPDATA\\Tutti"/);
  assert.match(include, /RMDir \/r "\$LOCALAPPDATA\\@tutti-osdesktop-updater"/);
  assert.match(include, /DeleteRegKey HKCU "Software\\Classes\\tutti"/);
  assert.match(
    include,
    /\$\{GetOptions\} \$0 "--delete-app-data" \$1[\s\S]*Goto deleteUserState/,
  );
  assert.match(
    include,
    /\$\{GetOptions\} \$0 "\/S" \$1[\s\S]*Goto preserveUserState/,
  );
  assert.match(
    include,
    /\$\{GetOptions\} \$0 "--updated" \$1[\s\S]*Goto preserveUserState/,
  );
  assert.match(
    include,
    /IDYES deleteUserState IDNO preserveUserState\s+Abort "Uninstall canceled\."/,
  );
  assert.ok(
    include.indexOf("Abort \"Uninstall canceled.\"") <
      include.indexOf('Push "$PROFILE\\.tutti\\bin\\tutti.cmd"'),
  );
});
