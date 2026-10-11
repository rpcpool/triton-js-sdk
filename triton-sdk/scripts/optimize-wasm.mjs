import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import binaryen from "binaryen";

const path = new URL("../src/wasm/account_encoding/yellowstone_account_sync_account_encoding_wasm_bg.wasm", import.meta.url);
const input = await readFile(path);
const exports = WebAssembly.Module.exports(new WebAssembly.Module(input));
const api = new Set(["encode_account", "get_account_mint", "convert_account_data"]);
const module = binaryen.readBinary(input);

// Only the SDK API and wasm-bindgen runtime are called by the bundled JavaScript.
// Dependency bindings otherwise retain unused cryptography functions.
for (const { name, kind } of exports) {
  if (kind === "function" && !api.has(name) && !name.startsWith("__wbindgen_") && !name.startsWith("__externref_")) {
    module.removeExport(name);
  }
}
for (const name of api) assert.ok(module.getExport(name), `missing WASM export: ${name}`);

binaryen.setOptimizeLevel(2);
binaryen.setShrinkLevel(2);
module.optimize();
// A second pass shrinks code exposed by the first pass.
module.optimize();
module.runPasses(["strip-debug", "strip-producers"]);
assert.ok(module.validate(), "optimized WASM must validate");
const output = module.emitBinary();
assert.ok(WebAssembly.validate(output), "optimized WASM must compile in Node");
await writeFile(path, output);
module.dispose();
console.log(`WASM: ${input.length} -> ${output.length} bytes`);
