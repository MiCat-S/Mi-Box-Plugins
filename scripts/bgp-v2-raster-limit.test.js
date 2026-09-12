'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const core = path.resolve(__dirname, '../../TeleBox-Core');
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const {artifactDir} = buildPlugin({id: 'bgp', packageRoot: path.resolve(__dirname, '../bgp'), entry: 'v2.ts'});
const {BGP_INPUT_PIXEL_LIMIT, rasterizeGraph} = require(path.join(artifactDir, 'index.cjs'));

test('bgp rejects an externally supplied SVG above its explicit raster pixel budget', async t => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mibot-bgp-v2-')));
  t.after(() => fs.rm(directory, {recursive: true, force: true}));
  assert.equal(BGP_INPUT_PIXEL_LIMIT, 32 * 1024 * 1024);
  const output = path.join(directory, 'oversized.png');
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="2000" height="2000"><rect width="100%" height="100%"/></svg>');
  await assert.rejects(rasterizeGraph(svg, output), /pixel limit/i);
  await assert.rejects(fs.stat(output), {code: 'ENOENT'});
});

test('bgp still rasterizes a normal external SVG inside the budget', async t => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mibot-bgp-small-v2-')));
  t.after(() => fs.rm(directory, {recursive: true, force: true}));
  const output = path.join(directory, 'normal.png');
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="100%" height="100%" fill="white"/></svg>');
  await rasterizeGraph(svg, output);
  assert.ok((await fs.stat(output)).size > 0);
});
