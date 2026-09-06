'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const core = path.resolve(__dirname, '../../TeleBox-Core');
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const {artifactDir} = buildPlugin({id: 'dig-location', packageRoot: path.resolve(__dirname, '../dig'), entry: 'v2/location.ts'});
const {annotateLocations} = require(path.join(artifactDir, 'index.cjs'));
function fixture(respond) {
  const controller = new AbortController(), calls = [];
  const ctx = {signal: controller.signal, http: {async withResponse(url, init, consume, options) {
    calls.push(url);
    assert.equal(options.timeoutMs, 3000);
    return consume(await respond(url, calls.length, controller), controller.signal);
  }}};
  return {ctx, calls, controller};
}
test('location annotates short and detailed IPs with deduplicated bounded requests', async () => {
  const f = fixture(() => Response.json({country: '<中国>', region: '<中国>', city: '上海', asn: 123}));
  const output = await annotateLocations(f.ctx, '1.1.1.1\nexample.com. 300 IN A 1.1.1.1\n2001:db8::1\nTXT "1.2.3.4"');
  assert.equal(f.calls.length, 2);
  assert.equal(output.match(/<中国> · 上海 · AS123/g).length, 3);
  assert.match(output, /TXT "1.2.3.4"$/);
});
test('location rejects non-success responses and uses legacy fallback fields', async () => {
  const f = fixture((url, n) => n === 1
    ? Response.json({country: 'wrong'}, {status: 503})
    : Response.json({country: 'US', org: 'AS13335 Cloudflare'}));
  assert.equal(await annotateLocations(f.ctx, '1.1.1.1'), '1.1.1.1\n  US · AS13335');
  assert.deepEqual(f.calls, ['https://api.ip.sb/geoip/1.1.1.1', 'https://ipinfo.io/1.1.1.1/json']);
});
test('location failure preserves all DNS records and avoids duplicate retries', async () => {
  const f = fixture(() => Response.json({bogon: true}));
  const input = '127.0.0.1\n127.0.0.1\nexample.com. 300 IN MX 10 mail.example.com.';
  assert.equal(await annotateLocations(f.ctx, input), input);
  assert.equal(f.calls.length, 2);
});
test('oversized location streams are cancelled before fallback', async () => {
  let cancelled = 0;
  const f = fixture((url, n) => n === 1 ? new Response(new ReadableStream({
    start(c) {c.enqueue(new Uint8Array(16385));},
    cancel() {cancelled++;}
  })) : Response.json({asn: 'AS42'}));
  assert.equal(await annotateLocations(f.ctx, '1.1.1.1'), '1.1.1.1\n  AS42');
  assert.equal(cancelled, 1);
});
test('unload aborts lookup without starting fallback or another address', async () => {
  const f = fixture((url, n, controller) => {
    controller.abort();
    return Response.json({country: 'US'});
  });
  await assert.rejects(annotateLocations(f.ctx, '1.1.1.1\n8.8.8.8'), {name: 'AbortError'});
  assert.equal(f.calls.length, 1);
});
