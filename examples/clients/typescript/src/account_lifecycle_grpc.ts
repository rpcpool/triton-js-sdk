import {
  AccountSyncTransports,
  Connection,
  PublicKey,
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
  const commitment = parseCommitment(positional[1]);
  const publicKey = new PublicKey(account);

  console.log(
    `connecting (grpc) using endpoint=${endpointForLog(rpcEndpoint)} commitment=${commitment}`,
  );

  const connection = new Connection(rpcEndpoint, {
    accountSync: {
      transport: AccountSyncTransports.GRPC,
      subscriptionEndpoint: rpcEndpoint,
      commitment,
      initialAccounts: [],
      ...ACCOUNT_SYNC_LIMITS,
      dynamicSubscriptionTtlMs: 5_000,
      grpc: GRPC_CHANNEL_OPTIONS,
    },
  });

  try {
    console.log(`adding account at commitment=${commitment}: ${account}`);
    await connection.addAccounts([publicKey], commitment);
    await printCurrentState(connection, publicKey, commitment, "first read");

    console.log("removing account and releasing its cached state");
    await connection.removeAccounts([publicKey], commitment);

    // A read after removal would create a new temporary lease. Re-add first when
    // the account should remain pinned to the live subscription.
    console.log("re-adding account before reading it again");
    await connection.addAccounts([publicKey], commitment);
    await printCurrentState(connection, publicKey, commitment, "read after re-add");

    console.log(
      "un-pinned reads use a 5 second lease; pinned accounts stay until removeAccounts",
    );
  } finally {
    await connection.close();
  }
}

async function printCurrentState(
  connection: Connection,
  publicKey: PublicKey,
  commitment: "processed" | "confirmed" | "finalized",
  label: string,
): Promise<void> {
  const response = await connection.getAccountInfoAndContext(publicKey, {
    commitment,
  });
  console.log(
    JSON.stringify({
      label,
      contextSlot: response.context.slot,
      status: response.value === null ? "confirmed-missing" : "present",
      accountInfo: response.value,
    }),
  );
}

function usage(): string {
  return [
    "Usage:",
    "  npm run example:grpc:lifecycle -- [--rpc-endpoint <rpc_endpoint>] [account] [commitment]",
  ].join("\n");
}

void main().catch(reportExampleError);
