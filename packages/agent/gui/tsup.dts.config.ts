import { defineConfig, type Options } from "tsup";

import {
  agentGUIBuildEntries,
  agentGUIDtsEntryGroups
} from "./build/agentGuiBuildEntries";

export default defineConfig(
  agentGUIDtsEntryGroups.map((entryNames, index): Options => {
    const entry = Object.fromEntries(
      entryNames.map((name) => [name, agentGUIBuildEntries[name]])
    );

    return {
      name: `dts:${index + 1}`,
      clean: false,
      dts: { only: true },
      entry,
      external: ["react", "react-dom"],
      format: ["esm"]
    };
  })
);
