'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const root = path.resolve(__dirname, '..');
const core = path.resolve(root, '../TeleBox-Core');
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const {prepareArtifact} = require(path.join(core, 'dist/v2/artifacts.js'));
const {PluginHost} = require(path.join(core, 'dist/v2/host.js'));
const {buildPluginDetails} = require(path.join(core, 'dist/v2/builtins/help.js'));
const {ui} = require(path.join(core, 'dist/v2/sdk.js'));
const {HTMLParser} = require(path.join(core, 'node_modules/teleproto/extensions/html.js'));
const {Parser} = require(path.join(core, 'node_modules/htmlparser2'));
const ids = fs.readdirSync(root).filter(id => fs.existsSync(path.join(root, id, 'v2.ts'))).sort();
const visible = html => HTMLParser.parse(html)[0].replace(/\s+/gu, ' ').trim();
const prefix = '<&🙂';

test.before(() => {
  test.mock.method(globalThis, 'fetch', () => assert.fail('Help must not issue live HTTP'));
  test.mock.method(require('node:net').Socket.prototype, 'connect', () => assert.fail('Help must not open a network connection'));
});

function validate(pages) {
  assert.ok(pages.length);
  for (const page of pages) {
    assert.ok(page.length <= ui.MAX_HTML_LENGTH, 'page fits the message budget');
    assert.ok(HTMLParser.parse(page)[1].length <= ui.MAX_ENTITIES, 'page fits the entity budget');
    assert.ok(!page.includes('__PREFIX__'));
    assert.ok(!/此段(?:包含不支持|超出单条消息)/.test(page), 'authored help uses supported formatting');
    const parser = new Parser({onclosetag(_name, implied) {assert.equal(implied, false, 'tags close within each page');}}, {xmlMode: true});
    parser.end(page);
  }
}

for (const id of ids) test(`${id}: complete artifact help survives both command and catalog rendering`, async t => {
  const {artifactDir} = buildPlugin({id, packageRoot: path.join(root, id), entry: 'v2.ts'});
  const artifact = await prepareArtifact(artifactDir);
  const storage = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), `mibot-help-${id}-`)));
  const output = [];
  const forbidden = async () => assert.fail('Help must not invoke plugin work');
  const host = new PluginHost({storageRoot: storage, prefixes: [prefix], logger: {info() {}, error() {}},
    telegram: {async edit(_message, text, options) {assert.equal(options.parseMode, 'html'); output.push(text);},
      async reply(_message, text, options) {assert.equal(options.parseMode, 'html'); output.push(text);},
      getReply: forbidden, invoke: forbidden, withClient: forbidden}});
  t.after(async () => {
    assert.equal((await host.shutdown(1000)).completed, true);
    artifact.release();
    await fsp.rm(storage, {recursive: true, force: true});
  });
  const definition = artifact.create();
  assert.equal(typeof definition.renderHelp, 'function', `${id} supplies full help`);
  const source = definition.renderHelp(prefix);
  const expected = visible(source);
  assert.ok(expected.length, 'help has visible content');
  const commands = Object.fromEntries(Object.entries(definition.commands).map(([name, entry]) => [name, {...entry, handle: forbidden}]));
  // Help routing is independent of account data, background jobs and settings initialization.
  await host.load({...definition, commands, setup: undefined, cleanup: undefined, jobs: undefined,
    listeners: undefined, services: undefined, settings: undefined, resources: undefined});
  for (const [name, command] of Object.entries(commands)) {
    assert.ok(expected.includes(`${prefix}${name}`), `help documents registered command ${name} with the active prefix`);
    for (const args of [['--help'], ...(command.helpArgs || []).map(arg => [arg]), ...(command.helpOnEmpty ? [[]] : [])]) {
      output.length = 0;
      await host.dispatchPrimary({id: 1, chatId: '1', senderId: '1', outgoing: true,
        text: `${prefix}${name}${args.length ? ` ${args.join(' ')}` : ''}`});
      validate(output);
      assert.equal(visible(output.join('\n')), expected, 'all section bodies and examples are delivered');
    }
  }
  const details = await ui.renderDocument(await buildPluginDetails(host.listPlugins()[0], prefix, {}));
  validate(details);
  assert.ok(visible(details.join('\n')).includes(expected), 'catalog help includes the full authored guide');
  if (id === 'autochangename') {
    for (const section of ['基础操作', '时区管理', '外观设置', '文案管理', '天气显示', '查看配置']) assert.ok(expected.includes(section));
    for (const example of ['acn text add', 'acn tz format GMT', 'acn style italic', 'acn weather set 北京']) assert.ok(expected.includes(`${prefix}${example}`));
  }
});
