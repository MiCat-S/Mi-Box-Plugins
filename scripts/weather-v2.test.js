'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
const core = path.resolve(__dirname, '../../TeleBox-Core');
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const {PluginHost} = require(path.join(core, 'dist/v2/host.js'));
const {artifactDir} = buildPlugin({id: 'weather', packageRoot: path.resolve(__dirname, '../weather'), entry: 'v2.ts'});
const create = require(path.join(artifactDir, 'index.cjs')).default;

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mi-box-weather-v2-')));
  const edits = [];
  const fetch = async url => {
    const parsed = new URL(url);
    if (parsed.hostname.includes('geocoding')) return new Response(JSON.stringify({results: [{name: 'Beijing', country: 'China', latitude: 39.9, longitude: 116.4}]}), {status: 200});
    return new Response(JSON.stringify({current: {temperature_2m: 20, apparent_temperature: 19, relative_humidity_2m: 50, weather_code: 0, wind_speed_10m: 8}, daily: {temperature_2m_max: [25], temperature_2m_min: [12], sunrise: ['2026-09-06T05:30'], sunset: ['2026-09-06T18:30']}}), {status: 200});
  };
  const host = new PluginHost({storageRoot: root, logger: {info() {}, error() {}}, http: {fetch}, telegram: {
    async edit(message, text, options) { edits.push({text, options}); }, async reply() { assert.fail('unexpected reply'); },
    async invoke() { assert.fail('unexpected invoke'); }, async getReply() { return undefined; }, async withClient() { assert.fail('unexpected native call'); },
  }});
  await host.load(create());
  t.after(async () => { await host.shutdown(1000); await fs.rm(root, {recursive: true, force: true}); });
  return {edits, run: text => host.dispatchPrimary({id: 1, chatId: '1', senderId: '1', outgoing: true, text})};
}

test('weather help and invalid input stay local', async t => {
  const f = await fixture(t);
  await f.run('.weather help');
  await f.run('.weather <bad>');
  assert.match(f.edits[0].text, /天气查询/);
  assert.match(f.edits.at(-1).text, /有效的城市名/);
});

test('weather queries geocoding and forecast through bounded HTTP', async t => {
  const f = await fixture(t);
  await f.run('.weather 北京');
  assert.match(f.edits.at(-1).text, /Beijing/);
  assert.match(f.edits.at(-1).text, /20°C/);
  assert.equal(f.edits.at(-1).options.parseMode, 'html');
});
