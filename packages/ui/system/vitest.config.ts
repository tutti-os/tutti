import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const rootDir = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "#lib/utils": `${rootDir}src/lib/utils.ts`,
      "#icons/system-icons": `${rootDir}src/icons/system-icons.tsx`
    }
  },
  test: {
    // Vitest owns `.spec.*` files; legacy `.test.ts` files in this package use
    // the node:test runner, so keep them out of vitest's glob.
    include: ["src/**/*.spec.{ts,tsx}"],
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"]
  }
});
