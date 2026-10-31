import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node22",
  platform: "node",
  sourcemap: true,
  clean: true,
  noExternal: ["@edgeguard/shared"],
  banner: {
    js: "#!/usr/bin/env node",
  },
});
