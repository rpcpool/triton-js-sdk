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
const DEFAULT_DATA_SLICE = "0:32";

async function main(): Promise<void> {
  const { rpcEndpoint, positional } = parseRpcEndpointArgs(
    process.argv.slice(2),
    DEFAULT_RPC_ENDPOINT,
    usage,
  );
  if (positional.length > 3) {
    throw new Error(`too many arguments\n${usage()}`);
  }

  const account = normalizeAccountArg(positional[0] ?? DEFAULT_ACCOUNT);
  const commitment = parseCommitment(positional[1]);
  const dataSlice = parseDataSlice(positional[2] ?? DEFAULT_DATA_SLICE);
  const config: GetAccountInfoConfig = { commitment, dataSlice };
  const publicKey = new PublicKey(account);

  console.log(
    `connecting (grpc) using endpoint=${endpointForLog(rpcEndpoint)} commitment=${commitment} dataSlice=${dataSlice.offset}:${dataSlice.length}`,
  );

  const connection = new Connection(rpcEndpoint, {
    accountSync: {
      transport: AccountSyncTransports.GRPC,
      subscriptionEndpoint: rpcEndpoint,
      commitment,
      initialAccounts: [publicKey],
      ...ACCOUNT_SYNC_LIMITS,
      grpc: GRPC_CHANNEL_OPTIONS,
    },
  });

  try {
    const response = await connection.getAccountInfoAndContext(publicKey, config);
    if (response.value === null) {
      console.log(
        `account is confirmed missing: account=${account} contextSlot=${response.context.slot}`,
      );
      return;
    }

    console.log(
      `received sliced account info: contextSlot=${response.context.slot} dataLength=${response.value.data.length}`,
    );
    console.log(JSON.stringify(response.value));
  } finally {
    await connection.close();
  }
}

function parseDataSlice(value: string): { offset: number; length: number } {
  const parts = value.split(":");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(
      `invalid data slice '${value}': expected offset:length, for example 8:32`,
    );
  }

  return {
    offset: parseNonNegativeSafeInteger("data slice offset", parts[0]),
    length: parseNonNegativeSafeInteger("data slice length", parts[1]),
  };
}

function parseNonNegativeSafeInteger(name: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(
      `invalid ${name} '${value}': expected a non-negative integer`,
    );
  }
  return parsed;
}

function usage(): string {
  return [
    "Usage:",
    "  npm run example:grpc:data-slice -- [--rpc-endpoint <rpc_endpoint>] [account] [commitment] [offset:length]",
  ].join("\n");
}

void main().catch(reportExampleError);
