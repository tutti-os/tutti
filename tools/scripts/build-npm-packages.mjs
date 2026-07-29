import { execFileSync } from "node:child_process";

import {
  getNpmReleasePackages,
  parseReleasePackageFilters,
  workspaceRoot
} from "./npm-release-packages.mjs";

const packageNames = parseReleasePackageFilters(process.argv.slice(2));
const packages = await getNpmReleasePackages({ packageNames });
const args = packages.flatMap((packageConfig) => [
  "--filter",
  packageNames === null ? packageConfig.name : `${packageConfig.name}...`
]);

args.push("build");

execFileSync("pnpm", args, {
  cwd: workspaceRoot,
  stdio: "inherit"
});
