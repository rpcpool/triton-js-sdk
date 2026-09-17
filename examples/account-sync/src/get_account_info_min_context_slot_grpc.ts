import {
  AccountSyncTransports,
  Connection,
  PublicKey,
  type GetAccountInfoConfig,
} from "@triton-one/triton-sdk";
import {
  normalizeAccountArg,
  parseCommitment,
  parseRpcEndpointArgs,
} from "./example_args.ts";
import {
  ACCOUNT_SYNC_LIMITS,
  endpointForLog,
  GRPC_CHANNEL_OPTIONS,
  reportExampleError,
} from "./sdk_example_helpers.ts";

const DEFAULT_RPC_ENDPOINT = "https://example.com/yourToken";
const DEFAULT_ACCOUNT = "ping6gwBZx1ccMMFyLgkVSupUmujYrFidEXuNRPq989";
const SLOT_OFFSET = 30;
const MISS_TIMEOUT_MS = 30_000;

interface JsonRpcResponse<T> {
  result?: T;
  error?: {
    code: number;
    message: string;
  };
}

async function main(): Promise<void> {
  const { rpcEndpoint, positional } = parseRpcEndpointArgs(
    process.argv.slice(2),
    DEFAULT_RPC_ENDPOINT,
    usage,
  );
  if (positional.length > 2) {
    throw new Error(`too many arguments\n${usage()}`);
  }

  const account = normalizeAccountArg(positional[0] ?? DEFAULT_ACCOUNT);
  const commitment = parseCommitment(positional[1], "processed");
  const publicKey = new PublicKey(account);

  const finalizedSlot = await getFinalizedSlot(rpcEndpoint);
  const minContextSlot = finalizedSlot + SLOT_OFFSET;
  const getAccountInfoConfig: GetAccountInfoConfig = {
    commitment,
    minContextSlot,
  };

  console.log(
    `connecting (grpc) using endpoint=${endpointForLog(rpcEndpoint)} commitment=${commitment} finalizedSlot=${finalizedSlot} minContextSlot=${minContextSlot}`,
  );

  const connection = new Connection(rpcEndpoint, {
    accountSync: {
      transport: AccountSyncTransports.GRPC,
      subscriptionEndpoint: rpcEndpoint,
      commitment,
      initialAccounts: [publicKey],
      ...ACCOUNT_SYNC_LIMITS,
      missTimeoutMs: MISS_TIMEOUT_MS,
      grpc: GRPC_CHANNEL_OPTIONS,
    },
  });

  try {
    const response = await connection.getAccountInfoAndContext(
      publicKey,
      getAccountInfoConfig,
    );
    if (response.context.slot < minContextSlot) {
      throw new Error(
        `SDK returned context slot ${response.context.slot} before requested minContextSlot ${minContextSlot}`,
      );
    }
    if (response.value === null) {
      console.log(
        `account is confirmed missing: account=${account} contextSlot=${response.context.slot} minContextSlot=${minContextSlot}`,
      );
      return;
    }

    console.log(
      `received account info: contextSlot=${response.context.slot} minContextSlot=${minContextSlot}`,
    );
    console.log(JSON.stringify(response.value));
  } finally {
    await connection.close();
  }
}

async function getFinalizedSlot(endpoint: string): Promise<number> {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getSlot",
      params: [
        {
          commitment: "finalized",
        },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(
      `getSlot HTTP request failed: status=${response.status} ${response.statusText}`,
    );
  }

  const payload = (await response.json()) as JsonRpcResponse<number>;
  if (payload.error) {
    throw new Error(
      `getSlot RPC error ${payload.error.code}: ${payload.error.message}`,
    );
  }
  const slot = payload.result;
  if (typeof slot !== "number" || !Number.isSafeInteger(slot)) {
    throw new Error("getSlot RPC response did not include a safe integer slot");
  }

  return slot;
}

function usage(): string {
  return [
    "Usage:",
    "  npm run example:grpc:min-context-slot -- [--rpc-endpoint <rpc_endpoint>] [account] [commitment]",
  ].join("\n");
}

void main().catch(reportExampleError);
