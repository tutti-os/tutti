import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const forwardedArgs = process.argv.slice(2);

for (const script of ["build-npm-packages.mjs", "check-package-packs.mjs"]) {
  execFileSync(
    process.execPath,
    [join(scriptDirectory, script), ...forwardedArgs],
    {
      stdio: "inherit"
    }
  );
}
