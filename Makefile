TRITON_RUST_SDK_DIR := triton-rust-sdk
TRITON_RUST_SDK_TAG := sdk-v0.1.0
YELLOWSTONE_GRPC_DIR := yellowstone-account-sync-proto/proto/yellowstone-grpc

.PHONY: setup-submodules
setup-submodules:
	git submodule update --init $(TRITON_RUST_SDK_DIR)
	git -C $(TRITON_RUST_SDK_DIR) fetch --tags
	git -C $(TRITON_RUST_SDK_DIR) checkout --detach refs/tags/$(TRITON_RUST_SDK_TAG)
	git -C $(TRITON_RUST_SDK_DIR) sparse-checkout set --no-cone '/.gitmodules' '/yellowstone-account-sync-proto/proto/*.proto' '/$(YELLOWSTONE_GRPC_DIR)'
	git -C $(TRITON_RUST_SDK_DIR) submodule update --init $(YELLOWSTONE_GRPC_DIR)
	git -C $(TRITON_RUST_SDK_DIR)/$(YELLOWSTONE_GRPC_DIR) sparse-checkout set --no-cone '/yellowstone-grpc-proto/proto/*.proto'

clean: clean-nodejs clean-rust

clean-nodejs:
	rm -rf triton-sdk/dist
	rm -rf triton-sdk/node_modules
	rm -rf examples/clients/typescript/dist
	rm -rf examples/clients/typescript/node_modules

clean-rust:
	rm -rf target
	rm -rf triton-sdk/account-encoding-wasm/target

setup-rust-wasm-dependencies:
	rustup target add wasm32-unknown-unknown
	cargo install wasm-bindgen-cli --version 0.2.129
