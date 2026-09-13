import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    browser: "src/browser.ts",
    node: "src/node.ts"
  },
  format: ["esm"],
  target: "es2022",
  sourcemap: true,
  clean: true,
  dts: true,
  splitting: false,
  treeshake: true
});
