YELLOWSTONE_GRPC_DIR := yellowstone-account-sync-proto/proto/yellowstone-grpc
YELLOWSTONE_GRPC_TAG := client-v13.3.0

.PHONY: setup-submodules
setup-submodules:
	git submodule update --init $(YELLOWSTONE_GRPC_DIR)
	git -C $(YELLOWSTONE_GRPC_DIR) fetch --tags
	git -C $(YELLOWSTONE_GRPC_DIR) checkout $(YELLOWSTONE_GRPC_TAG)
	git -C $(YELLOWSTONE_GRPC_DIR) sparse-checkout init --cone
	git -C $(YELLOWSTONE_GRPC_DIR) sparse-checkout set yellowstone-grpc-proto

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
	cargo install wasm-bindgen-cli --version 0.2.100
