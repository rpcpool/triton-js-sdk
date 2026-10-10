import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";

const { RPC_URL, ACCOUNT_SYNC_URL } = process.env;
assert.ok(RPC_URL, "Set RPC_URL to run the browser example");
assert.ok(ACCOUNT_SYNC_URL, "Set ACCOUNT_SYNC_URL to run the browser example");
const sdkEntry = import.meta.resolve("@triton-one/triton-sdk");
const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL("browser.js", sdkEntry))],
  bundle: true,
  platform: "browser",
  format: "esm",
  external: ["node:*", "fs/promises", "url"],
  write: false,
});
const wasmPath = "wasm/account_encoding/yellowstone_account_sync_account_encoding_wasm_bg.wasm";
const routes = new Map([
  ["/", ["text/html", await readFile(new URL("../src/browser_example.html", import.meta.url))]],
  ["/sdk.js", ["text/javascript", outputFiles[0].contents]],
  [`/${wasmPath}`, ["application/wasm", await readFile(new URL(wasmPath, sdkEntry))]],
]);
const server = createServer((request, response) => {
  const route = routes.get(request.url);
  if (!route) {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, { "Content-Type": route[0] }).end(route[1]);
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
let browser;
try {
  browser = await chromium.launch();
  const page = await browser.newPage();
  const pageError = new Promise((_, reject) => page.on("pageerror", reject));
  await page.addInitScript((settings) => { window.TRITON_EXAMPLE = settings; }, {
    rpcUrl: RPC_URL,
    accountSyncUrl: ACCOUNT_SYNC_URL,
    moduleUrl: "/sdk.js",
    once: true,
  });
  await Promise.race([
    pageError,
    page.goto(`http://127.0.0.1:${server.address().port}`).then(() =>
      page.locator('#output[data-complete="true"]').waitFor({ timeout: 60_000 })),
  ]);
  const result = JSON.parse(await page.locator("#output").textContent());
  assert.ok(Number.isSafeInteger(result.context.slot) && result.context.slot > 0);
  assert.ok(result.value);
  console.log("PASS: browser example");
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
