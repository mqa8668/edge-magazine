import { defineConfig } from "vitest/config";

// Unit tests run in the node environment: every target is pure logic or takes
// its bindings as arguments (mocked with fakeKV/fakeEnv in test/helpers.ts), so
// the Workers pool is unnecessary here. Integration tests that need real D1/R2
// can add @cloudflare/vitest-pool-workers later.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
