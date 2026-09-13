clean: clean-nodejs clean-rust

clean-nodejs:
	rm -rf yellowstone-account-sync-clients/typescript/dist
	rm -rf yellowstone-account-sync-clients/typescript/node_modules
	rm -rf examples/clients/typescript/dist
	rm -rf examples/clients/typescript/node_modules

clean-rust:
	rm -rf target
	rm -rf yellowstone-account-sync-clients/typescript/account-encoding-wasm/target

setup-rust-wasm-dependencies:
	rustup target add wasm32-unknown-unknown
	cargo install wasm-bindgen-cli --version 0.2.100