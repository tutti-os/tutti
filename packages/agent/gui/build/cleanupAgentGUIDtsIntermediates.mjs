import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const intermediateDirectory = fileURLToPath(
  new URL("../dist/.dts", import.meta.url)
);

await rm(intermediateDirectory, { force: true, recursive: true });
