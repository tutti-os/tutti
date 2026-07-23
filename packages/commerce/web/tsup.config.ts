import { defineConfig } from "tsup";

const assetSubpaths = [
  "@tutti-os/commerce/assets/star-free.png",
  "@tutti-os/commerce/assets/star-lite.png",
  "@tutti-os/commerce/assets/star-pro.png",
  "@tutti-os/commerce/assets/star-ultra.png",
  "@tutti-os/commerce/assets/registration-credits-bg.png"
];

export default defineConfig({
  clean: true,
  dts: true,
  entry: {
    index: "src/index.ts",
    "react/index": "src/react/index.ts",
    "runtime-assets/star-free-url": "src/runtime-assets/star-free-url.ts",
    "runtime-assets/star-lite-url": "src/runtime-assets/star-lite-url.ts",
    "runtime-assets/star-pro-url": "src/runtime-assets/star-pro-url.ts",
    "runtime-assets/star-ultra-url": "src/runtime-assets/star-ultra-url.ts",
    "runtime-assets/registration-credits-bg-url":
      "src/runtime-assets/registration-credits-bg-url.ts"
  },
  external: [...assetSubpaths, "react", "react-dom"],
  format: ["esm"],
  sourcemap: true
});
