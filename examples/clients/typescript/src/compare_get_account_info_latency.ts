import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import {
  Connection as Web3Connection,
  type AccountInfo,
  PublicKey,
} from "@solana/web3.js";
import {
  AccountSyncTransports,
  Connection as TritonConnection,
} from "@triton-one/triton-sdk";
import { parseCommitment, parseRpcEndpointArgs } from "./example_args.ts";
import {
  ACCOUNT_SYNC_LIMITS,
  endpointForLog,
  GRPC_CHANNEL_OPTIONS,
  reportExampleError,
} from "./sdk_example_helpers.ts";

const DEFAULT_RPC_ENDPOINT = "https://example.com/yourToken";
const ACCOUNTS_CSV_PATH = fileURLToPath(
  new URL("../../../accounts.csv", import.meta.url),
);
const ACCOUNT_COUNT = 100;
const DEFAULT_POLL_INTERVAL_MS = 250;
const MAX_PRINTED_STATES = 10_000;

type Source = "triton" | "web3";
type AccountResult = AccountInfo<Buffer> | null;

interface TimedBatchRead {
  hash: string;
  durationMs: number;
}

interface FailedRead {
  source: Source;
  durationMs: number;
  error: unknown;
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

  const commitment = parseCommitment(positional[0]);
  const pollIntervalMs = parsePollInterval(positional[1]);
  const publicKeys = await loadPublicKeys(ACCOUNTS_CSV_PATH, ACCOUNT_COUNT);
  const tritonConnection = new TritonConnection(rpcEndpoint, {
    commitment,
    accountSync: {
      transport: AccountSyncTransports.GRPC,
      // subscriptionEndpoint: rpcEndpoint,
      commitment,
      initialAccounts: publicKeys,
      ...ACCOUNT_SYNC_LIMITS,
      grpc: GRPC_CHANNEL_OPTIONS,
    },
  });
  const web3Connection = new Web3Connection(rpcEndpoint, commitment);
  const printedStates = new Set<string>();
  const lastErrorBySource = new Map<Source, string>();
  let updateNumber = 0;
  let stopping = false;
  const stop = (): void => {
    stopping = true;
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  console.log(
    `comparing getMultipleAccountsInfo using endpoint=${endpointForLog(rpcEndpoint)} accounts=${publicKeys.length} commitment=${commitment} pollIntervalMs=${pollIntervalMs}`,
  );
  console.log("waiting for account states returned by both clients");

  try {
    while (!stopping) {
      const cycleStartedAtMs = performance.now();
      const [tritonRead, web3Read] = await Promise.all([
        measureBatchRead("triton", ACCOUNT_COUNT, () =>
          tritonConnection.getMultipleAccountsInfo(publicKeys, commitment),
        ),
        measureBatchRead("web3", ACCOUNT_COUNT, () =>
          web3Connection.getMultipleAccountsInfo(publicKeys, commitment),
        ),
      ]);

      if ("error" in tritonRead) {
        reportReadError(tritonRead, lastErrorBySource);
      } else {
        lastErrorBySource.delete("triton");
      }
      if ("error" in web3Read) {``
        reportReadError(web3Read, lastErrorBySource);
      } else {
        lastErrorBySource.delete("web3");
      }

      if (
        !("error" in tritonRead) &&
        !("error" in web3Read) &&
        tritonRead.read.hash === web3Read.read.hash &&
        !printedStates.has(tritonRead.read.hash)
      ) {
        updateNumber += 1;
        printMatchedState(updateNumber, tritonRead.read, web3Read.read);
        rememberPrintedState(printedStates, tritonRead.read.hash);
      }

      const cycleDurationMs = performance.now() - cycleStartedAtMs;
      await sleep(Math.max(0, pollIntervalMs - cycleDurationMs));
    }
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    await tritonConnection.close();
  }
}

async function loadPublicKeys(
  csvPath: string,
  count: number,
): Promise<PublicKey[]> {
  const csv = await readFile(csvPath, "utf8");
  const publicKeys: PublicKey[] = [];
  const seen = new Set<string>();

  for (const [index, rawLine] of csv.split(/\r?\n/u).entries()) {
    const value = rawLine.trim();
    if (!value) {
      continue;
    }

    let publicKey: PublicKey;
    try {
      publicKey = new PublicKey(value);
    } catch {
      throw new Error(`invalid public key in accounts.csv at line ${index + 1}`);
    }

    const normalized = publicKey.toBase58();
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    publicKeys.push(publicKey);
    if (publicKeys.length === count) {
      return publicKeys;
    }
  }

  throw new Error(
    `accounts.csv contains ${publicKeys.length} valid unique accounts; ${count} are required`,
  );
}

async function measureBatchRead(
  source: Source,
  expectedCount: number,
  read: () => Promise<AccountResult[]>,
): Promise<{ source: Source; read: TimedBatchRead } | FailedRead> {
  const startedAtMs = performance.now();
  try {
    const accounts = await read();
    if (accounts.length !== expectedCount) {
      throw new Error(
        `expected ${expectedCount} account results, received ${accounts.length}`,
      );
    }
    const durationMs = performance.now() - startedAtMs;
    return {
      source,
      read: {
        hash: hashAccounts(accounts),
        durationMs,
      },
    };
  } catch (error: unknown) {
    return {
      source,
      durationMs: performance.now() - startedAtMs,
      error,
    };
  }
}

function hashAccounts(accounts: readonly AccountResult[]): string {
  const hash = createHash("sha256");
  hash.update(String(accounts.length));
  for (const account of accounts) {
    hash.update("|");
    hash.update(fingerprintAccount(account));
  }
  return hash.digest("hex");
}

function fingerprintAccount(account: AccountResult): string {
  if (!account) {
    return "missing";
  }

  const hash = createHash("sha256");
  hash.update(String(account.lamports));
  hash.update("|");
  hash.update(account.owner.toBuffer());
  hash.update(account.executable ? "|1|" : "|0|");
  hash.update(String(account.rentEpoch));
  hash.update("|");
  hash.update(account.data);
  return hash.digest("hex");
}

function printMatchedState(
  updateNumber: number,
  triton: TimedBatchRead,
  web3: TimedBatchRead,
): void {
  const tritonDurationMs = Number(triton.durationMs.toFixed(3));
  const web3DurationMs = Number(web3.durationMs.toFixed(3));
  const winner = tritonDurationMs === web3DurationMs
    ? "tie"
    : tritonDurationMs < web3DurationMs
      ? "triton-account-sync"
      : "web3.js-rpc-poll";
  const fasterByMs = Math.abs(web3DurationMs - tritonDurationMs);

  console.log(`update=${updateNumber}`);
  console.log(`web3.js-rpc durationMs=${web3DurationMs.toFixed(3)}`);
  console.log(`triton-account-sync durationMs=${tritonDurationMs.toFixed(3)}`);
  console.log(`winner=${winner} fasterByMs=${fasterByMs.toFixed(3)}`);
}

function reportReadError(
  result: FailedRead,
  lastErrorBySource: Map<Source, string>,
): void {
  const errorName = result.error instanceof Error
    ? result.error.name
    : "UnknownError";
  if (lastErrorBySource.get(result.source) === errorName) {
    return;
  }
  lastErrorBySource.set(result.source, errorName);
  console.error(
    `${result.source} getMultipleAccountsInfo failed after ${result.durationMs.toFixed(3)}ms (${errorName})`,
  );
}

function rememberPrintedState(
  printedStates: Set<string>,
  hash: string,
): void {
  printedStates.add(hash);
  while (printedStates.size > MAX_PRINTED_STATES) {
    const oldest = printedStates.values().next().value as string | undefined;
    if (oldest === undefined) {
      return;
    }
    printedStates.delete(oldest);
  }
}

function parsePollInterval(value: string | undefined): number {
  if (value === undefined) {
    return DEFAULT_POLL_INTERVAL_MS;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(
      `invalid poll interval '${value}': expected a positive integer`,
    );
  }
  return parsed;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function usage(): string {
  return [
    "Usage:",
    "  npm run example:compare:get-account-info -- [--rpc-endpoint <rpc_endpoint>] [commitment] [poll_interval_ms]",
  ].join("\n");
}

void main().catch(reportExampleError);
