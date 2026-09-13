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

async function main(): Promise<void> {
  const { rpcEndpoint, positional } = parseRpcEndpointArgs(
    process.argv.slice(2),
    DEFAULT_RPC_ENDPOINT,
    usage,
  );
  if (positional.length > 2) {
    throw new Error(`too many arguments\n${usage()}`);
  }

  const accounts = normalizeAccountsArg(positional[0] ?? DEFAULT_ACCOUNTS);
  const commitment = parseCommitment(positional[1]);
  const config: GetMultipleAccountsConfig = { commitment };
  const publicKeys = accounts.map((account) => new PublicKey(account));

  console.log(
    `connecting (grpc) using endpoint=${endpointForLog(rpcEndpoint)} commitment=${commitment} accounts=${accounts.join(",")}`,
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
      `received account results: contextSlot=${response.context.slot}`,
    );
    printAccountInfos(accounts, response.value);
  } finally {
    await connection.close();
  }
}

function printAccountInfos(
  accounts: readonly string[],
  accountInfos: Awaited<
    ReturnType<Connection["getMultipleAccountsInfoAndContext"]>
  >["value"],
): void {
  accountInfos.forEach((accountInfo, index) => {
    console.log(
      JSON.stringify({
        index,
        account: accounts[index],
        status: accountInfo === null ? "confirmed-missing" : "present",
        accountInfo,
      }),
    );
  });
}

function usage(): string {
  return [
    "Usage:",
    "  npm run example:multiple:grpc -- [--rpc-endpoint <rpc_endpoint>] [accounts] [commitment]",
    "",
    "accounts must be comma-separated public keys",
  ].join("\n");
}

void main().catch(reportExampleError);
