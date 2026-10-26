import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts", "packages/runtime/test/**/*.test.ts"],
    testTimeout: 20000,
    fileParallelism: false,
  },
  resolve: {
    alias: {
      "@actionledger/core": fileURLToPath(
        new URL("./packages/core/src/index.ts", import.meta.url),
      ),
    },
  },
});
