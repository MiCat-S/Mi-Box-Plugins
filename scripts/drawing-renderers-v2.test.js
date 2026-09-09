'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const core = path.resolve(__dirname, '../../TeleBox-Core');
const root = path.resolve(__dirname, '..');
const esbuild = require(path.join(core, 'node_modules/esbuild'));
const canvas = require(path.join(core, 'node_modules/canvas'));
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
fs.mkdirSync(path.join(core, 'temp'), {recursive: true});
const stage = fs.mkdtempSync(path.join(core, 'temp/drawing-reference-'));
test.after(() => fs.rmSync(stage, {recursive: true, force: true}));

function load(name, source, entry) {
  const outfile = path.join(stage, `${name}.cjs`);
  esbuild.buildSync({...(entry ? {entryPoints: [entry]} : {stdin: {contents: source, loader: 'ts', resolveDir: core}}),
    outfile, bundle: true, platform: 'node', format: 'cjs', external: ['canvas'], logLevel: 'silent'});
  return require(outfile);
}
const cloud = load('cloud', null, path.join(root, 'cy/v2/wordcloud.ts'));
const chart = load('chart', null, path.join(root, 'nezha/v2/chart.ts'));
const captcha = load('captcha', null, path.join(root, 'pmcaptcha/v2/image.ts'));
function between(source, start, end) {return source.slice(source.indexOf(start), source.indexOf(end));}

const originalCloud = fs.readFileSync(path.join(root, 'cy/cy.ts'), 'utf8');
const cloudReference = load('cloud-reference', `import fs from 'node:fs';
${between(originalCloud, 'type CanvasModule =', 'const prefixes =')}
${between(originalCloud, 'const WIDTH =', 'type CyScheduleConfig =').replace('const CONFIG_PATH = path.join(__dirname, "cy_schedule.json");', '')}
${between(originalCloud, 'function isUsefulWord(', 'async function fetchRecentMessages(')}
export {collectWords, buildWordItems, renderWordCloud};`);
const originalChart = fs.readFileSync(path.join(root, 'nezha/nezha.ts'), 'utf8');
const chartReference = load('chart-reference', between(originalChart, 'function generateChartConfig(', 'async function downloadChart(') + '\nexport {generateChartConfig};');
const originalCaptcha = fs.readFileSync(path.join(root, 'pmcaptcha/pmcaptcha.ts'), 'utf8');
const captchaReference = load('captcha-reference', `async function tryGetCanvas(){return require('canvas');}
${between(originalCaptcha, 'async function generateImageCaptcha(', '// ─── 验证状态')}
export {generateImageCaptcha};`);

function seeded(seed = 12345) {return () => {seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296;};}

test('word cloud preserves original word selection, spiral placement, font sizes and PNG output', async () => {
  const messages = [
    '异步编程异步编程 数据分析 NodeJS open-source',
    '异步编程 TypeScript TypeScript 监控图表 监控图表',
    '数据分析 数据分析 开源社区 开源社区 HTTP https://example.com @ignored',
    '今天 现在 消息 我们 输入 输出',
  ];
  const actual = new Map(), expected = new Map();
  for (let repeat = 0; repeat < 5; repeat++) for (const message of messages) {
    cloud.collectWords(message, actual); cloudReference.collectWords(message, expected);
  }
  assert.deepEqual(actual, expected);
  const items = cloud.buildWordItems(actual), referenceItems = cloudReference.buildWordItems(expected);
  assert.deepEqual(items, referenceItems);
  assert.ok(items.length > 5);
  const image = cloud.renderWordCloud(items, 500, 20);
  const original = cloudReference.renderWordCloud(referenceItems, 500, 20);
  assert.deepEqual(image, original);
  const decoded = await canvas.loadImage(image);
  assert.equal(decoded.width, 900); assert.equal(decoded.height, 640);
});

test('Nezha chart preserves original colors, axes and full-range sampling with missing points', () => {
  for (const size of [0, 12, 501]) {
    const data = Array.from({length: 7}, (_, index) => ({monitor_name: `Monitor ${index}`,
      created_at: Array.from({length: size}, (_, point) => 1700000000000 + point * 60000),
      avg_delay: Array.from({length: index === 1 ? Math.min(10, size) : size}, (_, point) => point + index)}));
    const actual = chart.generateChartConfig(data, 'Test Server');
    assert.deepEqual(actual, chartReference.generateChartConfig(data, 'Test Server'));
    if (size > 200) {
      assert.equal(actual.data.labels.length, 200);
      assert.equal(actual.data.datasets[0].data[0], 0);
      assert.equal(actual.data.datasets[0].data.at(-1), size - 1);
      assert.equal(actual.data.datasets[1].data.at(-1), null);
      assert.equal(actual.options.legend.position, 'bottom');
      assert.equal(actual.options.scales.yAxes[0].scaleLabel.labelString, 'Delay (ms)');
    }
  }
});

test('image captcha preserves original seeded pixels and five-character answer in both modes', async t => {
  for (const digitOnly of [true, false]) {
    t.mock.method(Math, 'random', seeded());
    const actual = await captcha.generateImageCaptcha(digitOnly);
    t.mock.method(Math, 'random', seeded());
    const expected = await captchaReference.generateImageCaptcha(digitOnly);
    assert.deepEqual(actual, expected);
    assert.match(actual.answer, digitOnly ? /^\d{5}$/ : /^[A-HJ-NP-Z2-9]{5}$/);
    const image = await canvas.loadImage(actual.buffer);
    assert.equal(image.width, 240); assert.equal(image.height, 90);
  }
});

test('Nezha command sends the original chart configuration to the existing provider', async () => {
  const {artifactDir} = buildPlugin({id: 'nezha', packageRoot: path.join(root, 'nezha'), entry: 'v2.ts'});
  const plugin = require(path.join(artifactDir, 'index.cjs')).default();
  const data = [{monitor_name: 'Probe', created_at: [1700000000000, 1700000060000], avg_delay: [12, 15]}];
  let chartBody, sent = 0;
  const signal = new AbortController().signal;
  const ctx = {signal, storage: {json: () => ({read: async () => ({url: 'https://nezha.example', secret: 'fixture-secret'})})},
    http: {withResponse: async (url, options, read) => {
      const location = new URL(url);
      if (location.hostname === 'quickchart.io') {chartBody = JSON.parse(options.body); return read(new Response(Buffer.from('png')), signal);}
      return read(Response.json({success: true, data: location.pathname.endsWith('/server') ? [{id: 1, name: 'Test Server'}] : data}), signal);
    }}, files: {withTemp: async fn => fn(stage, signal)},
    telegram: {edit: async () => {}, withClient: async fn => fn({sendFile: async () => {sent++;}}, signal)}};
  await plugin.commands.nezha.handle({args: ['chart', '1'], prefix: '.', message: {id: 1, chatId: '1', text: '.nezha chart 1'}}, ctx);
  assert.equal(sent, 1);
  assert.deepEqual(chartBody, {chart: chartReference.generateChartConfig(data, 'Test Server'), width: 800, height: 400, backgroundColor: 'black', format: 'png'});
});
