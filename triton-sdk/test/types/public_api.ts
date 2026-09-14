import type {
  AccountInfo,
  Connection as Web3Connection,
  ParsedAccountData,
  PublicKey,
  RpcResponseAndContext
} from "@solana/web3.js";
import type { Buffer } from "buffer";
import type { Connection } from "@triton-one/triton-sdk";

type Assert<T extends true> = T;
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2)
    ? (<T>() => T extends B ? 1 : 2) extends
        (<T>() => T extends A ? 1 : 2)
      ? true
      : false
    : false;

type MethodsMatch = [
  Assert<Equal<Connection["getAccountInfo"], Web3Connection["getAccountInfo"]>>,
  Assert<
    Equal<
      Connection["getAccountInfoAndContext"],
      Web3Connection["getAccountInfoAndContext"]
    >
  >,
  Assert<
    Equal<Connection["getParsedAccountInfo"], Web3Connection["getParsedAccountInfo"]>
  >,
  Assert<
    Equal<
      Connection["getMultipleAccountsInfo"],
      Web3Connection["getMultipleAccountsInfo"]
    >
  >,
  Assert<
    Equal<
      Connection["getMultipleAccountsInfoAndContext"],
      Web3Connection["getMultipleAccountsInfoAndContext"]
    >
  >,
  Assert<
    Equal<
      Connection["getMultipleParsedAccounts"],
      Web3Connection["getMultipleParsedAccounts"]
    >
  >
];

type ResponseShapes = [
  Assert<
    Equal<
      Awaited<ReturnType<Connection["getAccountInfoAndContext"]>>,
      RpcResponseAndContext<AccountInfo<Buffer> | null>
    >
  >,
  Assert<
    Equal<
      Awaited<ReturnType<Connection["getParsedAccountInfo"]>>,
      RpcResponseAndContext<AccountInfo<Buffer | ParsedAccountData> | null>
    >
  >,
  Assert<Equal<AccountInfo<Buffer>["owner"], PublicKey>>
];

export type PublicApiChecks = [MethodsMatch, ResponseShapes];
