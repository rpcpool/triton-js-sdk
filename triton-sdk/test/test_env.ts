export interface TestEndpoints {
  rpcEndpoint: string;
  wsEndpoint: string;
  grpcEndpoint: string;
}

// What: Reads test endpoints from environment variables.
// Why: Tests should run against configurable endpoints across local/CI setups.
// How: Pull from `process.env` with stable localhost defaults.
export function getTestEndpoints(): TestEndpoints {
  return {
    rpcEndpoint: process.env.TEST_RPC_ENDPOINT ?? "http://127.0.0.1:8899",
    wsEndpoint: process.env.TEST_WS_ENDPOINT ?? "ws://127.0.0.1:12000",
    grpcEndpoint: process.env.TEST_GRPC_ENDPOINT ?? "http://127.0.0.1:11000"
  };
}
