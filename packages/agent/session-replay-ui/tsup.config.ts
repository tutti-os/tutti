import { defineConfig } from "tsup";

export default defineConfig({
  clean: true,
  dts: true,
  entry: {
    "activity-event": "src/activity-event.ts",
    "activity-replay-driver": "src/activity-replay-driver.ts",
    index: "src/index.ts",
    "interaction-contract": "src/interaction-contract.ts",
    "react-binding": "src/react-binding.tsx",
    "workspace-contract": "src/workspace-contract.ts"
  },
  format: ["esm"],
  sourcemap: true
});
