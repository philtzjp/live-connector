import * as fs from "node:fs"
import * as esbuild from "esbuild"
import type { ExtensionManifest } from "./src/types/manifest"

const manifest = JSON.parse(fs.readFileSync("manifest.json", "utf8")) as ExtensionManifest
const production = process.argv.includes("--production")

// Extension Host の VM コンテキストには AbortSignal などの Web globals が存在しない。
// ただし Host 外側の Node ランタイムには存在するため、どのモジュール初期化よりも先に
// banner で外側の globalThis からコピーする（inject では undici 読み込み順に間に合わない）。
const globalsBanner = `(function(){
  var g = globalThis;
  function set(n, v){ if (g[n] === undefined && v !== undefined) g[n] = v; }
  function tryReq(m){ try { return require(m); } catch (e) { return undefined; } }
  var vm = tryReq("node:vm");
  function hostGlobal(n){
    if (!vm || typeof vm.runInThisContext !== "function") return undefined;
    try { return vm.runInThisContext("globalThis[" + JSON.stringify(n) + "]"); } catch (e) { return undefined; }
  }
  [
    "AbortController","AbortSignal","Blob","DOMException","Event","EventTarget","File","FormData",
    "Headers","MessageChannel","MessagePort","ReadableStream","Request","Response","TextDecoder",
    "TextEncoder","TransformStream","URL","URLSearchParams","WebSocket","WritableStream",
    "ByteLengthQueuingStrategy","CountQueuingStrategy","crypto","fetch","performance","queueMicrotask",
    "structuredClone"
  ].forEach(function(k){ set(k, hostGlobal(k)); });
  var util = require("node:util");
  set("TextEncoder", util.TextEncoder); set("TextDecoder", util.TextDecoder);
  var url = require("node:url");
  set("URL", url.URL); set("URLSearchParams", url.URLSearchParams);
  var web = require("node:stream/web");
  ["ReadableStream","WritableStream","TransformStream","ByteLengthQueuingStrategy","CountQueuingStrategy"].forEach(function(k){ set(k, web[k]); });
  var nodeBuffer = require("node:buffer");
  set("Blob", nodeBuffer.Blob); set("File", nodeBuffer.File);
  var perf = tryReq("node:perf_hooks"); if (perf) set("performance", perf.performance);
  var nodeCrypto = tryReq("node:crypto"); if (nodeCrypto) set("crypto", nodeCrypto.webcrypto);
  var wt = tryReq("node:worker_threads"); if (wt) { set("MessageChannel", wt.MessageChannel); set("MessagePort", wt.MessagePort); }
  set("queueMicrotask", function(cb){ Promise.resolve().then(cb); });
  var ets = tryReq("event-target-shim"); if (ets) { set("Event", ets.Event); set("EventTarget", ets.EventTarget); }
  var ac = tryReq("abort-controller"); if (ac) { set("AbortController", ac.AbortController); set("AbortSignal", ac.AbortSignal); }
  var scm = tryReq("@ungap/structured-clone"); if (scm) set("structuredClone", scm.default || scm);
  set("DOMException", tryReq("domexception"));
  var u = tryReq("undici");
  if (u) { ["Request","Response","Headers","FormData","File","fetch","WebSocket"].forEach(function(k){ set(k, u[k]); }); }
}());`

await esbuild.build({
    entryPoints: ["src/extension.ts"],
    outfile: manifest.entry,
    bundle: true,
    format: "cjs",
    platform: "node",
    // vm コンテキストに欠けている Web 標準グローバルを他モジュールより先に補う。
    // banner: require で取れる Node 組み込み系（最先頭で確実に実行）。
    // inject: undici 由来（Request/Response/Headers 等、bundle 同梱）。
    banner: { js: globalsBanner },
    inject: ["src/polyfill.ts"],
    // Extension Host は bundle を vm コンテキストで評価する。
    // - `global` が無いため globalThis に置換。
    // - 動的 import() は vm で使えない（callback 未指定エラー）ため require ベースへ変換。
    define: { global: "globalThis" },
    supported: { "dynamic-import": false },
    sourcesContent: false,
    logLevel: "info",
    minify: production,
    sourcemap: !production,
})
