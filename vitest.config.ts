import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Conformance tests exercise real lease/backoff timing against a live
    // server (a couple wait ~2s); give them headroom.
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
