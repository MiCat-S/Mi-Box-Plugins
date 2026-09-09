'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const core = path.resolve(__dirname, '../../TeleBox-Core');
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const {PluginHost} = require(path.join(core, 'dist/v2/host.js'));
const {artifactDir} = buildPlugin({id: 'bin', packageRoot: path.resolve(__dirname, '../bin'), entry: 'v2.ts'});
const create = require(path.join(artifactDir, 'index.cjs')).default;
const {HTMLParser} = require(path.join(core, 'node_modules/teleproto/extensions/html.js'));

async function fixture(t, {data, rates, ratesStatus = 200, checked = '', fetchRates} = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mi-box-bin-card-')));
  const edits = [], requests = [];
  const host = new PluginHost({storageRoot: root, logger: {info() {}, error() {}}, http: {
    fetch: async (url, init) => {
      requests.push(String(url));
      if (String(url).includes('bincheck.io')) return new Response(checked);
      if (String(url).includes('open.er-api.com')) return fetchRates ? fetchRates(init) : new Response(JSON.stringify(rates ?? {}), {status: ratesStatus});
      return new Response(JSON.stringify(data ?? {}));
    },
  }, telegram: {async edit(m, text, options) {edits.push({text, options});}, async reply(m, text, options) {edits.push({text, options});}, async invoke() {}, async getReply() {}, async withClient() {}}});
  await host.load(create());
  t.after(async () => { await host.shutdown(1000); await fs.rm(root, {recursive: true, force: true}); });
  return {host, edits, requests, run: (input = '41705691') => host.dispatchPrimary({id: 1, chatId: 'chat', senderId: 'owner', outgoing: true, text: `.bin ${input}`})};
}

test('bin card renders country metadata and dated cross rates in one safe message and reuses rates', async t => {
  const f = await fixture(t, {data: {scheme:'visa', type:'debit', brand:'CLASSIC', prepaid:false, commercial:false,
    bank:{name:'COSMOTE PAYMENTS <SERVICES> & Co.'}, country:{name:'Germany', alpha2:'DE', currency:'EUR'}, number:{length:16,luhn:true}},
    rates:{result:'success', base_code:'USD', time_last_update_unix:1788912000, rates:{USD:1, EUR:0.875, CNY:7}}});
  await f.run();
  const result = f.edits.at(-1);
  const [text, entities] = HTMLParser.parse(result.text);
  assert.match(text, /VISA · DEBIT（借记）/);
  assert.match(text, /级别  CLASSIC/);
  assert.match(text, /商业  否    ·    预付  否/);
  assert.match(text, /🇩🇪 Germany/);
  assert.match(text, /代码  DE    ·    区号  \+49/);
  assert.match(text, /地区  Europe/);
  assert.match(text, /EUR € · Euro/);
  assert.match(text, /1 EUR = 8\.00 CNY/);
  assert.match(text, /1 USD = 7\.00 CNY/);
  assert.match(text, /卡号长度  16 位 · Luhn 是/);
  assert.match(text, /2026-09-09/);
  assert.match(result.text, /&lt;SERVICES&gt; &amp; Co\./);
  assert.match(result.text, /<code>41705691<\/code>/);
  assert.equal(result.options.linkPreview, false);
  assert.ok(result.text.length <= 3500 && entities.length < 90);
  assert.equal(f.edits.length, 2);
  await f.run();
  assert.equal(f.requests.filter(url => url.includes('open.er-api')).length, 1);
});

test('bin keeps unknown flags distinct from false and preserves card details when rates fail', async t => {
  const f = await fixture(t, {data:{scheme:'visa', bank:{name:'Available Bank'}}, ratesStatus:503});
  await f.run();
  const text = HTMLParser.parse(f.edits.at(-1).text)[0];
  assert.match(text, /商业  未知    ·    预付  未知/);
  assert.match(text, /Available Bank/);
  assert.match(text, /区号  未知/);
  assert.match(text, /汇率暂不可用/);
  assert.doesNotMatch(text, /卡号规则|卡号长度|Luhn/);
  assert.doesNotMatch(f.edits.at(-1).text, /blockquote/);
  assert.doesNotMatch(text, /NaN|undefined|Infinity/);
});

test('bin validates before network, keeps country metadata coherent and deduplicates USD quotes', async t => {
  const f = await fixture(t, {data:{brand:'Business', scheme:'visa', country:{name:'United States',alpha2:'US',currency:'USD'}},
    checked:'<meta property="og:description" content="valid BIN number VISA issued by Bank in Germany">',
    rates:{result:'success',base_code:'USD',rates:{USD:1,CNY:7}}});
  await f.run('1234567890123456');
  assert.equal(f.requests.length, 0);
  await f.run();
  const text = HTMLParser.parse(f.edits.at(-1).text)[0];
  assert.match(text, /🇺🇸 United States/);
  assert.match(text, /区号  \+1/);
  assert.match(text, /商业  是/);
  assert.equal(text.split('1 USD =').length - 1, 1);
  assert.doesNotMatch(text, /Germany/);
});

test('bin unload aborts the optional exchange request without sending a result', async t => {
  let started;
  const ready = new Promise(resolve => {started = resolve;});
  const f = await fixture(t, {fetchRates: init => new Promise((resolve, reject) => {
    started();
    init.signal.addEventListener('abort', () => reject(init.signal.reason), {once:true});
  })});
  const running = f.run();
  await ready;
  assert.equal((await f.host.unload('bin', 1000)).completed, true);
  await running;
  assert.equal(f.edits.length, 1);
});

test('bin validates input and formats provider fields safely', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mi-box-bin-v2-')));
  const edits = [];
  const host = new PluginHost({storageRoot: root, logger: {info() {}, error() {}}, http: {
    fetch: async url => new Response(String(url).includes('bincheck.io')
      ? '<meta property="og:description" content="This number: 415042 is a valid BIN number VISA issued by Example Bank in Taiwan">'
      : JSON.stringify({scheme: 'visa', type: 'debit', brand: '<Brand>', number: {length: 16, luhn: true}, prepaid: true, bank: {name: 'Fallback Bank'}, country: {name: 'Taiwan', alpha2: 'TW', currency: 'TWD'}}), {status: 200}),
  }, telegram: {async edit(m, text, options) {edits.push({text, options});}, async reply() {}, async invoke() {}, async getReply() {}, async withClient() {}}});
  await host.load(create());
  t.after(async () => { await host.shutdown(1000); await fs.rm(root, {recursive: true, force: true}); });
  await host.dispatchPrimary({id: 1, chatId: 'chat', senderId: 'owner', outgoing: true, text: '.bin 415042'});
  assert.match(edits.at(-1).text, /VISA/);
  assert.match(edits.at(-1).text, /&lt;Brand&gt;/);
  assert.match(edits.at(-1).text, /Example Bank/);
  assert.match(edits.at(-1).text, /16 位/);
  assert.match(edits.at(-1).text, /预付  是/);
  assert.equal(edits.at(-1).options.parseMode, 'html');
});
