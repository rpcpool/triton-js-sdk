import {
  type AccountSyncCommitment,
  PublicKey,
} from "@triton-one/triton-sdk";

// Shared argument parsing for the example scripts.
export interface RpcEndpointArgs {
  rpcEndpoint: string;
  positional: string[];
}

export function parseRpcEndpointArgs(
  args: readonly string[],
  defaultRpcEndpoint: string,
  usage: () => string,
): RpcEndpointArgs {
  const positional: string[] = [];
  let rpcEndpoint: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--rpc-endpoint") {
      rpcEndpoint = setRpcEndpoint(
        rpcEndpoint,
        readFlagValue(args, index, "rpc-endpoint", usage),
        usage,
      );
      index += 1;
      continue;
    }

    if (arg.startsWith("--rpc-endpoint=")) {
      rpcEndpoint = setRpcEndpoint(
        rpcEndpoint,
        readInlineFlagValue(arg, "rpc-endpoint", usage),
        usage,
      );
      continue;
    }

    if (arg.startsWith("--")) {
      throw new Error(`unknown option '${arg}'\n${usage()}`);
    }

    positional.push(arg);
  }

  return {
    rpcEndpoint: rpcEndpoint ?? defaultRpcEndpoint,
    positional,
  };
}

export function deriveWebSocketEndpoint(rpcEndpoint: string): string {
  const normalizedEndpoint = rpcEndpoint.includes("://")
    ? rpcEndpoint
    : `http://${rpcEndpoint}`;
  const url = new URL(normalizedEndpoint);

  if (url.protocol === "http:") {
    url.protocol = "ws:";
  } else if (url.protocol === "https:") {
    url.protocol = "wss:";
  } else {
    throw new Error(
      `invalid rpc endpoint protocol '${url.protocol}': expected http or https`,
    );
  }

  return url.toString();
}

export function parseCommitment(
  value: string | undefined,
  fallback: AccountSyncCommitment = "confirmed",
): AccountSyncCommitment {
  if (!value) {
    return fallback;
  }

  if (value === "processed" || value === "confirmed" || value === "finalized") {
    return value;
  }

  throw new Error(
    `invalid commitment '${value}': expected processed, confirmed, or finalized`,
  );
}

export function normalizeAccountArg(value: string): string {
  const candidate = value.trim();
  if (!candidate) {
    throw new Error("invalid account public key: value is empty");
  }

  try {
    return new PublicKey(candidate).toBase58();
  } catch {
    throw new Error(
      `invalid account public key '${value}': expected base58-encoded Solana public key`,
    );
  }
}

export function normalizeAccountsArg(value: string): string[] {
  const accounts = value.split(",").map(normalizeAccountArg);
  if (accounts.length === 0) {
    throw new Error("invalid account public keys: value is empty");
  }

  return accounts;
}

function setRpcEndpoint(
  current: string | undefined,
  next: string,
  usage: () => string,
): string {
  if (current !== undefined) {
    throw new Error(`--rpc-endpoint was provided more than once\n${usage()}`);
  }
  return next;
}

function readFlagValue(
  args: readonly string[],
  index: number,
  name: string,
  usage: () => string,
): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`missing value for --${name}\n${usage()}`);
  }

  return normalizeFlagValue(value, name, usage);
}

function readInlineFlagValue(
  arg: string,
  name: string,
  usage: () => string,
): string {
  const value = arg.slice(name.length + 3);
  return normalizeFlagValue(value, name, usage);
}

function normalizeFlagValue(
  value: string,
  name: string,
  usage: () => string,
): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`missing value for --${name}\n${usage()}`);
  }

  return trimmed;
}
