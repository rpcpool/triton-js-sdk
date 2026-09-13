import { Buffer } from "buffer";
import dotenv from "dotenv";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Connection as Web3Connection,
  PublicKey,
  type AccountInfo,
  type GetAccountInfoConfig,
  type GetMultipleAccountsConfig
} from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import {
  AccountSyncTransports,
  Connection as SdkConnection,
  type NodeSubscriptionTransport
} from "../src/node";

dotenv.config({ quiet: true });

const ACCOUNT_INFO_KEYS = [
  "data",
  "executable",
  "lamports",
  "owner",
  "rentEpoch",
  "space"
] as const;
const ACCOUNT_FILE_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../k6/accounts.txt"
);
const DEFAULT_ACCOUNT_COUNT = 8;
const DEFAULT_RANDOM_SEED = 470;
const DEFAULT_COMMITMENT = "confirmed";
const DEFAULT_SLOT_LAG = 5_000;
const DEFAULT_MISS_TIMEOUT_MS = 10_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 2_000;
const DEFAULT_LIVE_TEST_TIMEOUT_MS = 180_000;
const READ_RETRIES = 3;
const READ_RETRY_DELAY_MS = 500;

type LiveTransport = NodeSubscriptionTransport;
type RuntimeAccountInfo<T> = AccountInfo<T> & {
  space: number;
};

interface LiveEnv {
  endpoint: string;
  token?: string;
  accountCount: number;
  randomSeed: number;
  missTimeoutMs: number;
  closeTimeoutMs: number;
  liveTestTimeoutMs: number;
}

interface MatchedAccount {
  publicKey: PublicKey;
  accountInfo: AccountInfo<Buffer> | null;
}

const liveEnv = readLiveEnv();

describe.each([AccountSyncTransports.GRPC, AccountSyncTransports.WS] as const)(
  "SDK response compatibility with @solana/web3.js over %s",
  (transport: LiveTransport) => {
    it(
      "matches getAccountInfo payload, schema, and field types for random accounts",
      async () => {
        const env = liveEnv;
        const rpcEndpoint = buildRpcEndpoint(env);
        const web3Connection = new Web3Connection(rpcEndpoint, DEFAULT_COMMITMENT);
        const randomAccounts = selectRandomAccounts(
          loadAccountFile(),
          env.accountCount,
          env.randomSeed ^ hashString(transport)
        );
        const sdkConnection = createSdkConnection(
          transport,
          env,
          randomAccounts
        );

        try {
          const currentSlot = await web3Connection.getSlot(DEFAULT_COMMITMENT);
          const minContextSlot = Math.max(0, currentSlot - DEFAULT_SLOT_LAG);
          const config: GetAccountInfoConfig & GetMultipleAccountsConfig = {
            commitment: DEFAULT_COMMITMENT,
            minContextSlot
          };

          const matchedAccounts: MatchedAccount[] = [];
          for (const publicKey of randomAccounts) {
            matchedAccounts.push(
              await expectGetAccountInfoMatchesEventually({
                label: `${transport} ${publicKey.toBase58()}`,
                publicKey,
                web3Connection,
                sdkConnection,
                config
              })
            );
          }

          const multipleAccountKeys = matchedAccounts
            .filter(({ accountInfo }) => accountInfo !== null)
            .map(({ publicKey }) => publicKey);
          expect(
            multipleAccountKeys.length,
            `${transport} random account set should include non-null accounts`
          ).toBeGreaterThan(0);

          await expectGetMultipleAccountsInfoMatchesEventually({
            label: `${transport} getMultipleAccountsInfo`,
            publicKeys: multipleAccountKeys,
            web3Connection,
            sdkConnection,
            config
          });
          await expectGetMultipleAccountsInfoAndContextMatchesEventually({
            label: `${transport} getMultipleAccountsInfoAndContext`,
            publicKeys: multipleAccountKeys,
            web3Connection,
            sdkConnection,
            config
          });

          const dataSliceSource = matchedAccounts.find(
            ({ accountInfo }) => accountInfo !== null && accountInfo.data.length > 0
          );
          expect(
            dataSliceSource,
            `${transport} random account set should include at least one account with data`
          ).toBeDefined();
          if (!dataSliceSource?.accountInfo) {
            return;
          }

          const dataSliceLength = Math.min(8, dataSliceSource.accountInfo.data.length);
          const dataSliceConfig: GetAccountInfoConfig & GetMultipleAccountsConfig = {
            ...config,
            dataSlice: {
              offset: 0,
              length: dataSliceLength
            }
          };
          await expectGetAccountInfoMatchesEventually({
            label: `${transport} ${dataSliceSource.publicKey.toBase58()} dataSlice`,
            publicKey: dataSliceSource.publicKey,
            web3Connection,
            sdkConnection,
            config: dataSliceConfig
          });
          await expectGetMultipleAccountsInfoMatchesEventually({
            label: `${transport} getMultipleAccountsInfo dataSlice`,
            publicKeys: [dataSliceSource.publicKey],
            web3Connection,
            sdkConnection,
            config: dataSliceConfig
          });
          await expectGetMultipleAccountsInfoAndContextMatchesEventually({
            label: `${transport} getMultipleAccountsInfoAndContext dataSlice`,
            publicKeys: [dataSliceSource.publicKey],
            web3Connection,
            sdkConnection,
            config: dataSliceConfig
          });

          expectLastTransportErrorIsNull(sdkConnection, transport);
        } finally {
          await closeConnectionWithTimeout(sdkConnection, env.closeTimeoutMs);
        }
      },
      liveEnv.liveTestTimeoutMs
    );
  }
);

function readLiveEnv(): LiveEnv {
  const endpoint = process.env.TEST_ENDPOINT?.trim();
  const token = process.env.TEST_TOKEN?.trim().replace(/^\/+|\/+$/g, "");
  if (!endpoint) {
    throw new Error("TEST_ENDPOINT is required for live tests");
  }

  return {
    endpoint,
    ...(token ? { token } : {}),
    accountCount: readIntegerEnvAtLeast(
      "TEST_WEB3_COMPAT_ACCOUNT_COUNT",
      DEFAULT_ACCOUNT_COUNT,
      1
    ),
    randomSeed: readPositiveIntegerEnv("TEST_RANDOM_SEED", DEFAULT_RANDOM_SEED),
    missTimeoutMs: readPositiveIntegerEnv(
      "TEST_MISS_TIMEOUT_MS",
      DEFAULT_MISS_TIMEOUT_MS
    ),
    closeTimeoutMs: readPositiveIntegerEnv(
      "TEST_CLOSE_TIMEOUT_MS",
      DEFAULT_CLOSE_TIMEOUT_MS
    ),
    liveTestTimeoutMs: readPositiveIntegerEnv(
      "TEST_LIVE_TIMEOUT_MS",
      DEFAULT_LIVE_TEST_TIMEOUT_MS
    )
  };
}

function readPositiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return fallback;
  }

  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }

  return parsed;
}

function readIntegerEnvAtLeast(
  name: string,
  fallback: number,
  minimum: number
): number {
  const parsed = readPositiveIntegerEnv(name, fallback);
  if (parsed < minimum) {
    throw new Error(`${name} must be at least ${minimum}`);
  }

  return parsed;
}

function loadAccountFile(): PublicKey[] {
  const seen = new Set<string>();
  const publicKeys: PublicKey[] = [];
  const content = readFileSync(ACCOUNT_FILE_PATH, "utf8");

  for (const [index, rawLine] of content.split(/\r?\n/).entries()) {
    const accountId = rawLine.trim();
    if (!accountId) {
      continue;
    }

    try {
      const publicKey = new PublicKey(accountId);
      const normalized = publicKey.toBase58();
      if (seen.has(normalized)) {
        continue;
      }

      seen.add(normalized);
      publicKeys.push(publicKey);
    } catch (cause) {
      throw new Error(
        `invalid account id in ${ACCOUNT_FILE_PATH}:${index + 1}: ${accountId}`,
        { cause }
      );
    }
  }

  return publicKeys;
}

function selectRandomAccounts(
  accounts: readonly PublicKey[],
  count: number,
  seed: number
): PublicKey[] {
  if (accounts.length < count) {
    throw new Error(
      `${ACCOUNT_FILE_PATH} has ${accounts.length} unique accounts, expected at least ${count}`
    );
  }

  const selected = new Map<string, PublicKey>();
  const rng = createSeededRandom(seed);
  while (selected.size < count) {
    const publicKey = accounts[Math.floor(rng() * accounts.length)];
    selected.set(publicKey.toBase58(), publicKey);
  }

  return [...selected.values()];
}

function createSdkConnection(
  transport: LiveTransport,
  env: LiveEnv,
  initialAccounts: readonly PublicKey[]
): SdkConnection {
  return new SdkConnection(buildRpcEndpoint(env), {
    commitment: DEFAULT_COMMITMENT,
    accountSync: {
      transport,
      commitment: DEFAULT_COMMITMENT,
      initialAccounts,
      autoSubscribeOnMiss: true,
      missTimeoutMs: env.missTimeoutMs
    }
  });
}

function buildRpcEndpoint(env: LiveEnv): string {
  return env.token
    ? appendPathToken(env.endpoint, env.token)
    : parseEndpointUrl(env.endpoint).toString();
}

function appendPathToken(endpoint: string, token: string): string {
  const url = parseEndpointUrl(endpoint);
  const tokenSegment = token.replace(/^\/+|\/+$/g, "");
  if (!tokenSegment) {
    throw new Error("TEST_TOKEN must contain a non-empty path segment");
  }

  const segments = url.pathname.split("/").filter(Boolean);
  const alreadyHasToken = segments[segments.length - 1] === tokenSegment;
  const alreadyHasGrpcPath = segments.includes(
    "YellowstoneAccountSyncGrpcService"
  );
  const alreadyHasWsPath = segments.includes("YellowstoneAccountSyncService");

  if (!alreadyHasToken && !alreadyHasGrpcPath && !alreadyHasWsPath) {
    segments.push(tokenSegment);
  }

  url.pathname = segments.length > 0 ? `/${segments.join("/")}` : "/";
  return url.toString();
}

function parseEndpointUrl(endpoint: string): URL {
  const isLocalEndpoint =
    endpoint.startsWith("localhost") ||
    endpoint.startsWith("127.0.0.1") ||
    endpoint.startsWith("[::1]") ||
    endpoint.startsWith("::1") ||
    endpoint.startsWith("0.0.0.0");
  const normalized = endpoint.includes("://")
    ? endpoint
    : isLocalEndpoint
      ? `http://${endpoint}`
      : `https://${endpoint}`;

  return new URL(normalized);
}

async function expectGetAccountInfoMatchesEventually({
  label,
  publicKey,
  web3Connection,
  sdkConnection,
  config
}: {
  label: string;
  publicKey: PublicKey;
  web3Connection: Web3Connection;
  sdkConnection: SdkConnection;
  config: GetAccountInfoConfig;
}): Promise<MatchedAccount> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= READ_RETRIES; attempt += 1) {
    const [web3AccountInfo, sdkAccountInfo] = await Promise.all([
      web3Connection.getAccountInfo(publicKey, config),
      sdkConnection.getAccountInfo(publicKey, config)
    ]);
    try {
      expectAccountInfoMatches({
        label: `${label} attempt ${attempt}`,
        web3AccountInfo,
        sdkAccountInfo
      });
      return { publicKey, accountInfo: sdkAccountInfo };
    } catch (error) {
      lastError = error;
      if (attempt < READ_RETRIES) {
        await sleep(READ_RETRY_DELAY_MS);
      }
    }
  }

  throw lastError;
}

async function expectGetMultipleAccountsInfoMatchesEventually({
  label,
  publicKeys,
  web3Connection,
  sdkConnection,
  config
}: {
  label: string;
  publicKeys: PublicKey[];
  web3Connection: Web3Connection;
  sdkConnection: SdkConnection;
  config: GetMultipleAccountsConfig;
}): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= READ_RETRIES; attempt += 1) {
    const [web3AccountInfos, sdkAccountInfos] = await Promise.all([
      web3Connection.getMultipleAccountsInfo(publicKeys, config),
      sdkConnection.getMultipleAccountsInfo(publicKeys, config)
    ]);

    try {
      expectAccountInfoArraysMatch({
        label: `${label} attempt ${attempt}`,
        publicKeys,
        web3AccountInfos,
        sdkAccountInfos
      });
      return;
    } catch (error) {
      lastError = error;
      if (attempt < READ_RETRIES) {
        await sleep(READ_RETRY_DELAY_MS);
      }
    }
  }

  throw lastError;
}

async function expectGetMultipleAccountsInfoAndContextMatchesEventually({
  label,
  publicKeys,
  web3Connection,
  sdkConnection,
  config
}: {
  label: string;
  publicKeys: PublicKey[];
  web3Connection: Web3Connection;
  sdkConnection: SdkConnection;
  config: GetMultipleAccountsConfig;
}): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= READ_RETRIES; attempt += 1) {
    const [web3Response, sdkResponse] = await Promise.all([
      web3Connection.getMultipleAccountsInfoAndContext(publicKeys, config),
      sdkConnection.getMultipleAccountsInfoAndContext(publicKeys, config)
    ]);

    try {
      expect(typeof web3Response.context.slot, `${label} web3.js context slot`).toBe(
        "number"
      );
      expect(typeof sdkResponse.context.slot, `${label} SDK context slot`).toBe(
        "number"
      );
      if (config.minContextSlot !== undefined) {
        expect(
          sdkResponse.context.slot,
          `${label} SDK context slot must satisfy minContextSlot`
        ).toBeGreaterThanOrEqual(config.minContextSlot);
      }
      expectAccountInfoArraysMatch({
        label: `${label} attempt ${attempt}`,
        publicKeys,
        web3AccountInfos: web3Response.value,
        sdkAccountInfos: sdkResponse.value
      });
      return;
    } catch (error) {
      lastError = error;
      if (attempt < READ_RETRIES) {
        await sleep(READ_RETRY_DELAY_MS);
      }
    }
  }

  throw lastError;
}

function expectAccountInfoArraysMatch({
  label,
  publicKeys,
  web3AccountInfos,
  sdkAccountInfos
}: {
  label: string;
  publicKeys: PublicKey[];
  web3AccountInfos: (AccountInfo<Buffer> | null)[];
  sdkAccountInfos: (AccountInfo<Buffer> | null)[];
}): void {
  expect(sdkAccountInfos.length, `${label} SDK length`).toBe(
    web3AccountInfos.length
  );
  expect(sdkAccountInfos.length, `${label} input length`).toBe(publicKeys.length);

  for (const [index, publicKey] of publicKeys.entries()) {
    expectAccountInfoMatches({
      label: `${label} index ${index} ${publicKey.toBase58()}`,
      web3AccountInfo: web3AccountInfos[index] ?? null,
      sdkAccountInfo: sdkAccountInfos[index] ?? null
    });
  }
}

function expectAccountInfoMatches({
  label,
  web3AccountInfo,
  sdkAccountInfo
}: {
  label: string;
  web3AccountInfo: AccountInfo<Buffer> | null;
  sdkAccountInfo: AccountInfo<Buffer> | null;
}): void {
  expectAccountInfoOrNullSchema(web3AccountInfo, `${label} web3.js`);
  expectAccountInfoOrNullSchema(sdkAccountInfo, `${label} SDK`);
  expect(sdkAccountInfo === null, `${label} nullness mismatch`).toBe(
    web3AccountInfo === null
  );

  if (!web3AccountInfo || !sdkAccountInfo) {
    return;
  }

  expect(sdkAccountInfo.owner.toBase58(), `${label} owner`).toBe(
    web3AccountInfo.owner.toBase58()
  );
  expect(sdkAccountInfo.lamports, `${label} lamports`).toBe(
    web3AccountInfo.lamports
  );
  expect(sdkAccountInfo.executable, `${label} executable`).toBe(
    web3AccountInfo.executable
  );
  expect(sdkAccountInfo.rentEpoch, `${label} rentEpoch`).toBe(
    web3AccountInfo.rentEpoch
  );
  expect(accountSpace(sdkAccountInfo), `${label} space`).toBe(
    accountSpace(web3AccountInfo)
  );
  expect(sdkAccountInfo.data, `${label} data`).toEqual(web3AccountInfo.data);
}

function expectAccountInfoOrNullSchema(
  accountInfo: AccountInfo<Buffer> | null,
  label: string
): void {
  if (accountInfo === null) {
    return;
  }

  expect(Object.keys(accountInfo).sort(), `${label} keys`).toEqual(
    [...ACCOUNT_INFO_KEYS].sort()
  );
  expect(Buffer.isBuffer(accountInfo.data), `${label} data type`).toBe(true);
  expect(accountInfo.owner, `${label} owner type`).toBeInstanceOf(PublicKey);
  expect(typeof accountInfo.lamports, `${label} lamports type`).toBe("number");
  expect(Number.isFinite(accountInfo.lamports), `${label} lamports finite`).toBe(
    true
  );
  expect(typeof accountInfo.rentEpoch, `${label} rentEpoch type`).toBe("number");
  expect(Number.isFinite(accountInfo.rentEpoch), `${label} rentEpoch finite`).toBe(
    true
  );
  expect(typeof accountSpace(accountInfo), `${label} space type`).toBe("number");
  expect(Number.isFinite(accountSpace(accountInfo)), `${label} space finite`).toBe(
    true
  );
  expect(typeof accountInfo.executable, `${label} executable type`).toBe(
    "boolean"
  );
}

function accountSpace(accountInfo: AccountInfo<Buffer> | null): number | undefined {
  return (accountInfo as RuntimeAccountInfo<Buffer> | null)?.space;
}

function expectLastTransportErrorIsNull(
  connection: SdkConnection,
  transport: LiveTransport
): void {
  const lastTransportError = connection.getLastTransportError();
  expect(
    lastTransportError,
    `${transport} transport error: ${lastTransportError?.message}`
  ).toBeNull();
}

async function closeConnectionWithTimeout(
  connection: SdkConnection,
  timeoutMs: number
): Promise<void> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`connection close timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    await Promise.race([connection.close(), timeout]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

function createSeededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function hashString(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }

  return hash;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
