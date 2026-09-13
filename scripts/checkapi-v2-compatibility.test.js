'use strict';
// Real PluginHost compatibility checks; AI calls are provided by a simulated service plugin.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const core = path.resolve(__dirname, '../../TeleBox-Core');
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const {PluginHost} = require(path.join(core, 'dist/v2/host.js'));
const {definePlugin, STRUCTURED_PLUGIN_API_VERSION} = require(path.join(core, 'dist/v2/sdk.js'));
const packageRoot = process.env.CHECKAPI_PACKAGE_ROOT || path.resolve(__dirname, '../checkapi');
const {artifactDir} = buildPlugin({id: 'checkapi', packageRoot, entry: 'v2.ts'});
const createCheckapi = require(path.join(artifactDir, 'index.cjs')).default;

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'checkapi-compat-')));
  const edits = [], calls = [];
  const ai = definePlugin({apiVersion: STRUCTURED_PLUGIN_API_VERSION, id: 'ai', description: 'fixture AI',
    commands: {fixture: {description: 'fixture', async handle() {}}}, services: {
    selection: {description: 'fixture selection', async handle() {
      calls.push({service: 'selection'}); return {providers: [{tag: 'main', type: 'openai', models: {chat: 'gpt'}}, {tag: 'backup', type: 'openai'}]};
    }},
    models: {description: 'fixture models', async handle(input) {
      calls.push({service: 'models', input});
      if (input.tag === 'broken') throw new Error('secret-provider-error');
      return input.tag === 'main' ? ['m1', 'm2'] : ['b1'];
    }},
    chat: {description: 'fixture chat', async handle(input) {calls.push({service: 'chat', input}); return 'ok';}},
    diagnostics: {description: 'fixture diagnostics', async handle(input) {calls.push({service: 'diagnostics', input});
      if (input.action === 'benchmark') return {provider:{tag:input.tag,type:'openai',displayName:'OpenAI'},balance:{status:'unsupported',fields:[]},benchmarks:[
        {model:'gpt-4.1-mini',ok:true,elapsedMs:1000,usage:{total:25}}, {model:'gpt-4o-mini',ok:false,elapsedMs:10,error:'limited'}]};
      return {provider:{tag:input.tag,type:'openai',displayName:`API ${input.tag}`},balance:{status:'ok',fields:[{label:'套餐',value:'pro'}]},
        chat:{ok:true,text:'ok',model:'gpt',elapsedMs:20,usage:{prompt:1,completion:2,total:3}},models:{ok:true,names:['m1','m2']}};
    }},
  }});
  const host = new PluginHost({storageRoot: root, prefixes: ['!'], logger: {info() {}, error() {}},
    telegram: {async edit(_message, text, options) {edits.push({text, options});}, async reply() {}, async invoke() {}, async getReply() {}, async withClient() {}}});
  await host.load(ai); await host.load(createCheckapi());
  t.after(async () => {await host.shutdown(1000); await fs.rm(root, {recursive: true, force: true});});
  return {host, edits, calls, send: text => host.dispatchPrimary({id: 1, chatId: 'chat', senderId: '1', outgoing: true, text})};
}

test('CHECKAPI-COMPAT-01 delete remains an alias of credential management', async t => {
  const f = await fixture(t); await f.send('!checkapi delete old');
  assert.match(f.edits.at(-1).text, /API 连接由 ai 插件统一管理/);
  assert.doesNotMatch(f.edits.at(-1).text, /检测失败/);
});

test('CHECKAPI-COMPAT-02 check without a tag checks every configured provider', async t => {
  const f = await fixture(t); await f.send('!checkapi check');
  assert.match(f.edits.at(-1).text, /main.*✅ 2 个模型/s);
  assert.match(f.edits.at(-1).text, /backup.*✅ 1 个模型/s);
  assert.deepEqual(f.calls.filter(call => call.service === 'models').map(call => call.input.tag), ['main', 'backup']);
});

test('CHECKAPI-COMPAT-03 speed renders every benchmark with token throughput and isolated errors', async t => {
  const f=await fixture(t);await f.send('!checkapi speed main');const output=f.edits.at(-1).text;
  assert.match(output,/gpt-4\.1-mini.*1000ms \(25\.0 tok\/s\)/s);assert.match(output,/gpt-4o-mini.*limited/s);
  assert.deepEqual(f.calls.find(call=>call.service==='diagnostics').input,{action:'benchmark',tag:'main'});
});

test('CHECKAPI-COMPAT-04 compare renders full balance, chat metadata, usage, and model lists for both tags', async t => {
  const f=await fixture(t);await f.send('!checkapi compare main backup');const output=f.edits.map(item=>item.text).join('\n');
  assert.match(output,/API main.*套餐: pro.*响应: "ok" \(20ms\).*Token: 入1 出2 计3.*共 2 个/s);
  assert.match(output,/API backup.*套餐: pro.*响应: "ok" \(20ms\).*Token: 入1 出2 计3.*共 2 个/s);
});
