# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

**Note:** Version 0 of Semantic Versioning is handled differently from version 1 and above.
The minor version will be incremented upon a breaking change and the patch version will be incremented for features.

## 2026-10-11

- triton-sdk 0.1.2

### Updated
- reduced wasm build size
- unpinned wasm dependencies
- bumped wasm dependencies

## 2026-10-10

- triton-sdk 0.1.1

### Removed
- yellowstone-account-sync-proto moved to triton-rust-sdk repo

### Updated
- SDK tests

### Added
- ci e2e tests for the SDK

## 2026-09-16

- triton-sdk 0.1.0
- yellowstone-account-sync-proto 0.1.0

### Features
- SDK: initial release for `@solana/web3.js` compatible `@triton-one/triton-sdk`
- proto: initial release for yellowstone-account-sync proto which wraps yellowstone-grpc-proto
