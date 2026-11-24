"use strict";
// LIVE run of the NEW extension engine (extension/engine.js, Google engine) on
// the segments the NEW content.js extracted from tests/fixtures/representative.html
// in Chromium (exported by tests/browser/content-harness.html).
// Makes real requests to translate.googleapis.com. Run with Deno:
//   deno run --allow-read --allow-write --allow-net=translate.googleapis.com tests/live/new_pipeline.cjs [segments.json results.json]
// The optional file names (inside tests/live) default to new-segments.json / new-results.json.
const fs = require("node:fs");
const path = require("node:path");
require(path.join(__dirname, "../../extension/engine.js"));
const [input = "new-segments.json", output = "new-results.json"] = process.argv.slice(2).map(name => path.basename(name));
const segments = JSON.parse(fs.readFileSync(path.join(__dirname, input), "utf8"));
// Deno's fetch does not implement every browser RequestInit option; drop the
// ones that only matter inside Chrome (cookies/referrer are never sent here).
const fetcher = (url, init) => { const { cache, referrerPolicy, credentials, ...rest } = init; return fetch(url, rest); };
const engine = globalThis.ParallelReadEngine.createGoogleEngine(fetcher);
(async () => {
  const out = [];
  // Same batching limits as config.js (8 segments / 4000 characters).
  for (let i = 0; i < segments.length; i += 8) {
    const batch = segments.slice(i, i + 8);
    const results = await engine.translateBatch(batch);
    batch.forEach((segment, index) => out.push({ source: segment.text.replace(/\[\[(\d+)\]\]/g, (m, d) => segment.literals[Number(d)]), result: results[index] }));
  }
  fs.writeFileSync(path.join(__dirname, output), JSON.stringify({ engine: "google translate_a/t via extension/engine.js 0.3.1", input, date: new Date().toISOString(), requests: Math.ceil(segments.length / 8), out }, null, 2));
  for (const item of out) console.log(item.result.ok ? item.result.text : "ERROR " + item.result.code);
})().catch(error => { console.error("FAILED", error.code, error.message); process.exitCode = 1; });
