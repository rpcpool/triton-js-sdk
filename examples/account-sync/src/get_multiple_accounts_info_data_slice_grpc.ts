import {
  AccountSyncTransports,
  Connection,
  PublicKey,
  type GetMultipleAccountsConfig,
} from "@triton-one/triton-sdk";
import {
  normalizeAccountsArg,
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
const DEFAULT_ACCOUNTS = `${DEFAULT_ACCOUNT},${DEFAULT_ACCOUNT}`;
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

  const accounts = normalizeAccountsArg(positional[0] ?? DEFAULT_ACCOUNTS);
  const commitment = parseCommitment(positional[1]);
  const dataSlice = parseDataSlice(positional[2] ?? DEFAULT_DATA_SLICE);
  const config: GetMultipleAccountsConfig = { commitment, dataSlice };
  const publicKeys = accounts.map((account) => new PublicKey(account));

  console.log(
    `connecting (grpc) using endpoint=${endpointForLog(rpcEndpoint)} commitment=${commitment} accounts=${accounts.join(",")} dataSlice=${dataSlice.offset}:${dataSlice.length}`,
  );

  const connection = new Connection(rpcEndpoint, {
    accountSync: {
      transport: AccountSyncTransports.GRPC,
      subscriptionEndpoint: rpcEndpoint,
      commitment,
      initialAccounts: publicKeys,
      ...ACCOUNT_SYNC_LIMITS,
      grpc: GRPC_CHANNEL_OPTIONS,
    },
  });

  try {
    const response = await connection.getMultipleAccountsInfoAndContext(
      publicKeys,
      config,
    );
    console.log(
      `received sliced account results: contextSlot=${response.context.slot}`,
    );
    response.value.forEach((accountInfo, index) => {
      console.log(
        JSON.stringify({
          index,
          account: accounts[index],
          status: accountInfo === null ? "confirmed-missing" : "present",
          dataLength: accountInfo?.data.length ?? null,
          accountInfo,
        }),
      );
    });
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
    "  npm run example:multiple:grpc:data-slice -- [--rpc-endpoint <rpc_endpoint>] [accounts] [commitment] [offset:length]",
    "",
    "accounts must be comma-separated public keys",
  ].join("\n");
}

void main().catch(reportExampleError);
