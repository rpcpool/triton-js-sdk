import { Buffer } from "buffer";
import { SolanaJSONRPCError } from "@solana/web3.js";
import type { InitialStateHydrationContext } from "../core/initial_state_plugin";
import type { AccountSyncCommitment, DecodedAccountUpdate } from "../core/types";

const MAX_ACCOUNTS_PER_REQUEST = 100;
const INITIAL_STATE_WRITE_VERSION = -1n;
const U64_MAX = (1n << 64n) - 1n;
const U64_MAX_AS_NUMBER = Number(U64_MAX);

export interface RpcInitialStatePluginSettings {
  endpoint: string;
  fetch?: typeof fetch;
}

interface JsonRpcResponse {
  jsonrpc?: string;
  id?: number | string | null;
  result?: {
    context?: {
      slot?: number | string;
    };
    value?: Array<RpcAccount | null>;
  };
  error?: {
    code?: number;
    message?: string;
    data?: unknown;
  };
}

interface RpcAccount {
  lamports?: number | string;
  owner?: string;
  executable?: boolean;
  rentEpoch?: number | string;
  data?: unknown;
}

export class RpcInitialStateFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RpcInitialStateFetchError";
  }
}

// What: Fetches initial account state through Solana JSON-RPC.
// Why: The local stream buffer needs a starting snapshot while gRPC updates start.
// How: Fire getMultipleAccounts requests with base64 data and insert decoded bytes.
export class RpcInitialStatePlugin {
  private readonly endpoint: string;
  private readonly fetchImpl: typeof fetch;

  constructor(settings: RpcInitialStatePluginSettings) {
    this.endpoint = settings.endpoint;
    this.fetchImpl = settings.fetch ?? requireFetch();
  }

  public async hydrate(context: InitialStateHydrationContext): Promise<void> {
    const chunks = context.singleRequest
      ? [context.accountIds]
      : chunkAccountIds(context.accountIds);

    await Promise.all(
      chunks.map(async (accountIds, index) => {
        await this.fetchChunk(accountIds, index + 1, context);
      })
    );
  }

  private async fetchChunk(
    accountIds: readonly string[],
    requestId: number,
    context: InitialStateHydrationContext
  ): Promise<void> {
    if (accountIds.length === 0 || context.signal.aborted) {
      return;
    }

    const response = await this.fetchImpl(this.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(buildGetMultipleAccountsRequest(
        requestId,
        accountIds,
        context.commitment,
        context.minContextSlot
      )),
      signal: context.signal
    });

    if (!response.ok) {
      const responseText = await response.text();
      throw new Error(`${response.status} ${response.statusText}: ${responseText}`);
    }

    const payload = (await response.json()) as JsonRpcResponse;
    if (payload.error) {
      throw new SolanaJSONRPCError(
        {
          code: payload.error.code,
          message: payload.error.message ?? "unknown error",
          data: payload.error.data
        },
        context.rpcErrorMessage ?? `failed to get info for accounts ${accountIds}`
      );
    }

    const slot = parseRpcInteger(payload.result?.context?.slot, "context.slot");
    const accounts = payload.result?.value;
    if (!Array.isArray(accounts)) {
      throw new RpcInitialStateFetchError(
        "initial account fetch response missing result.value"
      );
    }
    if (accounts.length !== accountIds.length) {
      throw new RpcInitialStateFetchError(
        "initial account fetch response account count mismatch"
      );
    }

    for (const [index, account] of accounts.entries()) {
      if (context.signal.aborted) {
        continue;
      }

      if (account === null) {
        context.remove(accountIds[index], slot);
        continue;
      }

      context.upsert(toDecodedAccountUpdate(accountIds[index], account, slot));
    }
  }
}

function buildGetMultipleAccountsRequest(
  requestId: number,
  accountIds: readonly string[],
  commitment: AccountSyncCommitment,
  minContextSlot?: number
): unknown {
  return {
    jsonrpc: "2.0",
    id: requestId,
    method: "getMultipleAccounts",
    params: [
      accountIds,
      {
        encoding: "base64",
        commitment,
        ...(minContextSlot === undefined ? {} : { minContextSlot })
      }
    ]
  };
}

function toDecodedAccountUpdate(
  accountId: string,
  account: RpcAccount,
  slot: bigint
): DecodedAccountUpdate {
  return {
    accountId,
    lamports: parseRpcInteger(account.lamports, `${accountId}.lamports`),
    owner: parseRequiredString(account.owner, `${accountId}.owner`),
    executable: parseRequiredBoolean(account.executable, `${accountId}.executable`),
    rentEpoch: parseRpcInteger(account.rentEpoch, `${accountId}.rentEpoch`),
    data: decodeBase64AccountData(account.data, accountId),
    slot,
    writeVersion: INITIAL_STATE_WRITE_VERSION
  };
}

function decodeBase64AccountData(data: unknown, accountId: string): Uint8Array {
  if (!Array.isArray(data) || data.length < 2) {
    throw new RpcInitialStateFetchError(
      `initial account fetch response for ${accountId} missing base64 data tuple`
    );
  }

  const [encoded, encoding] = data;
  if (typeof encoded !== "string" || encoding !== "base64") {
    throw new RpcInitialStateFetchError(
      `initial account fetch response for ${accountId} did not use base64 data`
    );
  }

  return new Uint8Array(Buffer.from(encoded, "base64"));
}

function parseRequiredString(value: unknown, name: string): string {
  if (typeof value !== "string") {
    throw new RpcInitialStateFetchError(
      `initial account fetch response has invalid ${name}`
    );
  }

  return value;
}

function parseRequiredBoolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") {
    throw new RpcInitialStateFetchError(
      `initial account fetch response has invalid ${name}`
    );
  }

  return value;
}

function parseRpcInteger(value: unknown, name: string): bigint {
  if (typeof value === "string") {
    if (!/^\d+$/.test(value)) {
      throw new RpcInitialStateFetchError(
        `initial account fetch response has invalid ${name}`
      );
    }

    return BigInt(value);
  }

  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    if (value === U64_MAX_AS_NUMBER) {
      return U64_MAX;
    }

    return BigInt(value);
  }

  throw new RpcInitialStateFetchError(
    `initial account fetch response has invalid ${name}`
  );
}

function chunkAccountIds(accountIds: readonly string[]): readonly string[][] {
  const chunks: string[][] = [];
  for (let index = 0; index < accountIds.length; index += MAX_ACCOUNTS_PER_REQUEST) {
    chunks.push(accountIds.slice(index, index + MAX_ACCOUNTS_PER_REQUEST));
  }

  return chunks;
}

function requireFetch(): typeof fetch {
  if (!globalThis.fetch) {
    throw new RpcInitialStateFetchError(
      "initial account fetch requires global fetch support"
    );
  }

  return globalThis.fetch.bind(globalThis);
}
