import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "test/sdk_live_integration.test.ts",
      "test/web3_response_compat.test.ts"
    ]
  }
});
