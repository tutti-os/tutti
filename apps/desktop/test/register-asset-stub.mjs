// Loaded via `node --import` before the test entry so static asset imports
// resolve to a stub string instead of throwing in the test runner.
import { register } from "node:module";

register("./asset-stub-hooks.mjs", import.meta.url);
