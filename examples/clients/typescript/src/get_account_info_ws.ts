import {
  AccountSyncTransports,
  Connection,
  PublicKey,
  type GetAccountInfoConfig,
} from "@triton-one/triton-sdk";
import {
  deriveWebSocketEndpoint,
  normalizeAccountArg,
  parseCommitment,
  parseRpcEndpointArgs,
} from "./example_args.ts";
import {
  ACCOUNT_SYNC_LIMITS,
  endpointForLog,
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

  const wsEndpoint = deriveWebSocketEndpoint(rpcEndpoint);
  const account = normalizeAccountArg(positional[0] ?? DEFAULT_ACCOUNT);
  const commitment = parseCommitment(positional[1]);
  const config: GetAccountInfoConfig = { commitment };
  const publicKey = new PublicKey(account);

  console.log(
    `connecting (ws) using endpoint=${endpointForLog(rpcEndpoint)} commitment=${commitment}`,
  );

  const connection = new Connection(rpcEndpoint, {
    wsEndpoint,
    accountSync: {
      transport: AccountSyncTransports.WS,
      subscriptionEndpoint: wsEndpoint,
      commitment,
      initialAccounts: [publicKey],
      ...ACCOUNT_SYNC_LIMITS,
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
      `received account info via local buffer: contextSlot=${response.context.slot}`,
    );
    console.log(JSON.stringify(response.value));
  } finally {
    await connection.close();
  }
}

function usage(): string {
  return [
    "Usage:",
    "  npm run example:ws -- [--rpc-endpoint <rpc_endpoint>] [account] [commitment]",
  ].join("\n");
}

void main().catch(reportExampleError);
