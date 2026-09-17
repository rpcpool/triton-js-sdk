import {
  AccountSyncTransports,
  Connection,
  PublicKey,
  type GetMultipleAccountsConfig,
} from "@triton-one/triton-sdk";
import {
  deriveWebSocketEndpoint,
  normalizeAccountsArg,
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
const DEFAULT_ACCOUNTS = `${DEFAULT_ACCOUNT},${DEFAULT_ACCOUNT}`;

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
  const accounts = normalizeAccountsArg(positional[0] ?? DEFAULT_ACCOUNTS);
  const commitment = parseCommitment(positional[1]);
  const config: GetMultipleAccountsConfig = { commitment };
  const publicKeys = accounts.map((account) => new PublicKey(account));

  console.log(
    `connecting (ws) using endpoint=${endpointForLog(rpcEndpoint)} commitment=${commitment} accounts=${accounts.join(",")}`,
  );

  const connection = new Connection(rpcEndpoint, {
    wsEndpoint,
    accountSync: {
      transport: AccountSyncTransports.WS,
      subscriptionEndpoint: wsEndpoint,
      commitment,
      initialAccounts: publicKeys,
      ...ACCOUNT_SYNC_LIMITS,
    },
  });

  try {
    const response = await connection.getMultipleAccountsInfoAndContext(
      publicKeys,
      config,
    );
    console.log(
      `received account results: contextSlot=${response.context.slot}`,
    );
    response.value.forEach((accountInfo, index) => {
      console.log(
        JSON.stringify({
          index,
          account: accounts[index],
          status: accountInfo === null ? "confirmed-missing" : "present",
          accountInfo,
        }),
      );
    });
  } finally {
    await connection.close();
  }
}

function usage(): string {
  return [
    "Usage:",
    "  npm run example:multiple:ws -- [--rpc-endpoint <rpc_endpoint>] [accounts] [commitment]",
    "",
    "accounts must be comma-separated public keys",
  ].join("\n");
}

void main().catch(reportExampleError);
