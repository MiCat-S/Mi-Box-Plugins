'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs/promises');
const core = path.resolve(__dirname, '../../TeleBox-Core');
const {Api,helpers,utils}=require(path.join(core,'node_modules/teleproto'));
const Database=require(path.join(core,'node_modules/better-sqlite3'));
const {ScopedSafeRegExp}=require(path.join(core,'dist/v2/safe-regexp.js'));
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const {artifactDir} = buildPlugin({id: 'shift', packageRoot: process.env.SHIFT_TEST_SOURCE || path.resolve(__dirname, '../shift'), entry: 'v2.ts'});
const create = require(path.join(artifactDir, 'index.cjs')).default;

function fixture(plugin = create(), options = {}) {
  const stateFile = path.join(os.tmpdir(), `shift-state-${process.pid}-${Math.random()}.json`);
  let data = {schemaVersion: 2, rules: [], backups: {}};
  let legacy = {};
  let beforeUpdate;
  const edits = [], replies = [], forwards = [], taskLabels = [], pending = [];
  const controller = new AbortController();
  const entities = {...{
    '@source': {className: 'Channel', id: '90071992547409931234', title: 'Source'},
    '@target': {className: 'Channel', id: '80071992547409931234', title: 'Target'},
    '@sender': {className: 'User', id: '70071992547409931234', firstName: 'Sender'},
    '@third': {className: 'Channel', id: '60071992547409931234', title: 'Third'},
  },...(options.entities??{})};
  const client = {
    async getEntity(value) {return entities[String(value)] || {className: 'User', id: String(value), firstName: String(value)};},
    async forwardMessages(target, parameters) {await options.forward?.();forwards.push({target, options: parameters}); return [];},
    async getMessages() {return [];},
    async sendFile() {},
  };
  const storage = {json(file) {return {
    async read() {return structuredClone(file === 'shift_v2.json' ? legacy : data);},
    async update(change) {
      if (file !== 'shift_v2.json' && beforeUpdate) {const operation = beforeUpdate; beforeUpdate = undefined; operation(data);}
      if (file === 'shift_v2.json') legacy = await change(structuredClone(legacy));
      else data = await change(structuredClone(data));
      return structuredClone(file === 'shift_v2.json' ? legacy : data);
    },
  };},sqlite(file,settings){assert.equal(file,'shift.db');assert.equal(settings.mustExist,true);return{async read(operation,signal){signal?.throwIfAborted();const db=new Database(options.sqliteFile,{fileMustExist:true,readonly:true});try{return operation(db);}finally{db.close();}}};}};
  const context = {signal: controller.signal, log: {info() {}, error() {}}, storage, regexp:{async test(pattern,input,settings){return options.regexp?options.regexp(pattern,input,settings):{matched:new RegExp(pattern,settings?.flags).test(input),timedOut:false};}}, telegram: {
    async edit(_message, text) {edits.push(text);}, async reply(_message,text){replies.push(text);}, async withClient(operation) {return operation(client, controller.signal);},
  }, files: {dataPath() {return stateFile;}, async withTemp(operation) {return operation('/tmp', controller.signal);}}, tasks: {run(label, operation) {
    taskLabels.push(label); const result = Promise.resolve().then(() => operation(controller.signal)); pending.push(result); return result;
  }}};
  const message = (chatId, id, text, raw = {}) => ({id, chatId, senderId: '1', outgoing: false, text, raw: {peerId: chatId, ...raw}});
  const run = (args, text = `.shift ${args.join(' ')}`, chatId = '-10050071992547409931234') => plugin.commands.shift.handle({command: 'shift', prefix: '.', args,
    message: {...message(chatId, 1, text), outgoing: true}}, context);
  return {plugin, context, controller, run, message, edits, replies, forwards, taskLabels, pending, stateFile, state: () => data, setState:value=>{data=value;},setLegacy: value => {legacy = value;},
    beforeNextUpdate: operation => {beforeUpdate = operation;}};
}

test('shift stores exact decimal IDs and forwards topic/send-as without Number coercion', async () => {
  const f = fixture();
  await f.run(['set', '@source', '@target|42', 'all', 'silent', 'send-as=@sender']);
  const rule = f.state().rules[0];
  assert.equal(rule.source, '-10090071992547409931234');
  assert.equal(rule.target, '-10080071992547409931234');
  assert.equal(rule.sendAs, '70071992547409931234');
  assert.equal(rule.topicId, 42);
  await f.plugin.listeners[0].handle(f.message(rule.source, 77, 'hello'), f.context);
  assert.equal(f.forwards.length, 1);
  assert.equal(f.forwards[0].target.toString(), rule.target);
  assert.equal(f.forwards[0].options.fromPeer.toString(), rule.source);
  assert.equal(f.forwards[0].options.sendAs.toString(), rule.sendAs);
  assert.equal(f.forwards[0].options.topMsgId, 42);
  assert.equal(f.forwards[0].options.silent, true);
  assert.equal(f.state().rules[0].stats.forwarded, 1);
});

test('shift filtering, safe regex whitelist, pause and loop checks share structured routing', async () => {
  const f = fixture();
  await f.run(['set', '@source', '@target', 'text']);
  await f.run(['filter', '1', 'add', 'needle']);
  const source = f.state().rules[0].source;
  await f.plugin.listeners[0].handle(f.message(source, 2, 'miss'), f.context);
  await f.plugin.listeners[0].handle(f.message(source, 3, 'has needle'), f.context);
  assert.equal(f.forwards.length, 1);
  await f.run(['whitelist', '1', 'add', '^has needle$']);
  await f.run(['whitelist', '1', 'enable']);
  await f.plugin.listeners[0].handle(f.message(source, 4, 'has needle plus'), f.context);
  await f.plugin.listeners[0].handle(f.message(source, 5, 'has needle'), f.context);
  assert.equal(f.forwards.length, 2);
  await f.run(['whitelist', '1', 'add', '(a+)+$']);
  assert.match(f.edits.at(-1), /白名单已更新/);
  await f.run(['pause', '1']);
  await f.plugin.listeners[0].handle(f.message(source, 6, 'has needle'), f.context);
  assert.equal(f.forwards.length, 2);
  await f.run(['set', '@target', '@source', 'all']);
  assert.match(f.edits.at(-1), /循环/);
});

test('shift groups albums in a tracked task and migrates legacy string IDs once', async () => {
  const f = fixture();
  await f.run(['set', '@source', '@target', 'photo']);
  await f.run(['filter', '1', 'add', 'album caption']);
  const source = f.state().rules[0].source;
  await f.plugin.listeners[0].handle(f.message(source, 9, 'album caption', {groupedId: '922337203685477000', photo: {}}), f.context);
  await f.plugin.listeners[0].handle(f.message(source, 8, '', {groupedId: '922337203685477000', photo: {}}), f.context);
  assert.ok(f.taskLabels.some(label => label.startsWith('shift-album:')));
  await Promise.all(f.pending);
  assert.deepEqual(f.forwards[0].options.messages, [8, 9]);

  const migrated = fixture();
  migrated.setLegacy({rules: {'-10090071992547409931234': {target_id: '-10080071992547409931234', options: ['all', 'replyTo:73', 'send-as=70071992547409931234'], paused: false, filters: []}}});
  await migrated.plugin.setup(migrated.context);
  assert.equal(migrated.state().rules[0].source, '-10090071992547409931234');
  assert.equal(migrated.state().rules[0].target, '-10080071992547409931234');
  assert.equal(migrated.state().rules[0].topicId, 73);
  assert.equal(migrated.state().rules[0].sendAs, '70071992547409931234');
  assert.equal(migrated.state().legacyImported, true);
});

test('shift export/import preserves valid rules and backup runs inside task scope', async () => {
  const source = fixture();
  await source.run(['set', '@source', '@target', 'all']);
  await source.run(['export']);
  const payload = source.edits.at(-1);
  const target = fixture();
  await target.run(['import'], `.shift import\n${payload}`);
  assert.equal(target.state().rules[0].source, source.state().rules[0].source);
  await target.run(['backup', '@source', '@target']);
  assert.ok(target.taskLabels.some(label => label.startsWith('shift-backup:')));
  await Promise.all(target.pending);
  assert.equal(Object.values(target.state().backups)[0].status, 'completed');
  await target.run(['backup', '@source', '@source']);
  assert.match(target.edits.at(-1), /不能相同/);
  assert.equal(Object.keys(target.state().backups).length, 1);
});

test('shift applies indexed mutations to stable source IDs under concurrent reordering', async () => {
  const f = fixture();
  await f.run(['set', '@source', '@target', 'all']);
  await f.run(['set', '@third', '@target', 'all']);
  const selectedSource = f.state().rules[0].source;
  f.beforeNextUpdate(data => data.rules.reverse());
  await f.run(['pause', '1']);
  assert.equal(f.state().rules.find(rule => rule.source === selectedSource).paused, true);
  assert.equal(f.state().rules.find(rule => rule.source !== selectedSource).paused, false);
});

test('shift clean persists normalized rules and removes invalid backup records', async () => {
  const f = fixture();
  await f.run(['set', '@source', '@target', 'all']);
  f.state().rules.push({source: 'invalid'});
  f.state().backups['../escape'] = {source: '1', target: '2'};
  await f.run(['clean']);
  assert.equal(f.state().rules.length, 1);
  assert.deepEqual(f.state().backups, {});
  assert.match(f.edits.at(-1), /移除 2 条/);
});

test('shift migration honors an explicitly empty V2 rule list and preserves extension fields', async t => {
  const f=fixture();t.after(()=>fs.rm(f.stateFile,{force:true}));
  const current={schemaVersion:2,rules:[],backups:{},future:{owner:'v2'}};f.setState(structuredClone(current));
  await fs.writeFile(f.stateFile,JSON.stringify(current));
  f.setLegacy({rules:{'1':{target_id:'2',options:['all']}},stats:{legacy:true},future:{owner:'legacy'}});
  await f.plugin.setup(f.context);
  assert.deepEqual(f.state().rules,[]);assert.equal(f.state().legacyImported,true);
  assert.deepEqual(f.state().stats,{legacy:true});assert.deepEqual(f.state().future,{owner:'v2'});
});

test('shift migrates actual SQLite rules and statistics with exact 64-bit IDs',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'shift-sqlite-')),file=path.join(directory,'shift.db');t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const db=new Database(file);db.exec('CREATE TABLE shift_rules(source_id INTEGER PRIMARY KEY,target_id INTEGER NOT NULL,options TEXT NOT NULL,target_type TEXT NOT NULL,paused INTEGER DEFAULT 0,created_at TEXT NOT NULL,filters TEXT NOT NULL);CREATE TABLE shift_stats(stats_key TEXT PRIMARY KEY,stats_data TEXT NOT NULL)');
  db.prepare('INSERT INTO shift_rules VALUES(?,?,?,?,?,?,?)').run(9007199254740993123n,8007199254740993123n,'["all","replyTo:73"]','channel',0,'2025-01-01T00:00:00.000Z','[]');
  db.prepare('INSERT INTO shift_stats VALUES(?,?)').run('shift.stats.9007199254740993123.2025-02-03',JSON.stringify({total:17,text:12,photo:5}));db.close();
  const f=fixture(create(),{sqliteFile:file});await f.plugin.setup(f.context);const rule=f.state().rules[0];
  assert.equal(rule.source,'9007199254740993123');assert.equal(rule.target,'8007199254740993123');assert.equal(rule.topicId,73);assert.equal(rule.stats.forwarded,17);assert.equal(rule.stats.lastForwardedAt,Date.parse('2025-02-03'));assert.equal(f.state().legacyImported,true);
});

test('shift maps recoverable Lowdb backup and historical statistics into the current model',async()=>{
  const f=fixture();f.setLegacy({rules:{'101':{target_id:'202',options:['all'],created_at:'2025-01-01T00:00:00Z'}},stats:{'2025-03-04':{'101':{total:9,text:9}}},backups:{legacy1:{sourceId:101,targetId:202,startedAt:'2025-03-01T00:00:00Z',status:'running',totalMessages:50,processedMessages:12,failedMessages:2,lastMessageId:77,reverse:true}}});
  await f.plugin.setup(f.context);const task=f.state().backups.legacy1;assert.equal(f.state().rules[0].stats.forwarded,9);assert.equal(task.source,'101');assert.equal(task.target,'202');assert.equal(task.order,'asc');assert.equal(task.processed,12);assert.equal(task.failed,2);assert.equal(task.cursor,77);assert.equal(task.status,'paused');
});

test('shift list uses complete SDK pagination', async () => {
  const f=fixture(),rules=Array.from({length:200},(_,index)=>({source:String(index+1),target:String(index+1001),options:['all'],paused:false,filters:[],whitelistEnabled:false,whitelistPatterns:[],sourceDisplay:'S',targetDisplay:'T',createdAt:1,stats:{forwarded:index,failed:0}}));
  f.setState({schemaVersion:2,legacyImported:true,rules,backups:{}});await f.run(['list']);
  assert.ok(f.replies.length>0);const output=[f.edits.at(-1),...f.replies].join('\n');assert.match(output,/1\. /);assert.match(output,/200\. /);
});

test('shift cancellation after native forwarding does not record success or failure', async () => {
  let f;f=fixture(create(),{forward:async()=>f.controller.abort()});await f.run(['set','@source','@target','all']);const source=f.state().rules[0].source;
  await assert.rejects(f.plugin.listeners[0].handle(f.message(source,7,'text'),f.context));
  assert.deepEqual(f.state().rules[0].stats,{forwarded:0,failed:0});
});

test('shift accepts real Teleproto BigInteger entity IDs and produces serializable forwarding peers', async () => {
  const sourceId=helpers.returnBigInt('90071992547409931234'),targetId=helpers.returnBigInt('80071992547409931234');let wire;
  const f=fixture(create(),{entities:{'@source':new Api.Channel({id:sourceId,accessHash:helpers.returnBigInt(1),title:'Source'}),'@target':new Api.Channel({id:targetId,accessHash:helpers.returnBigInt(2),title:'Target'})},forward:async()=>{
    const request=new Api.messages.ForwardMessages({fromPeer:new Api.InputPeerChannel({channelId:sourceId,accessHash:helpers.returnBigInt(1)}),id:[77],randomId:[helpers.returnBigInt(3)],toPeer:new Api.InputPeerChannel({channelId:targetId,accessHash:helpers.returnBigInt(2)}),silent:true});await request.resolve({getInputEntity:async value=>value},utils);wire=request.getBytes();
  }});
  await f.run(['set','@source','@target','all','silent']);const rule=f.state().rules[0];assert.equal(rule.source,'-10090071992547409931234');assert.equal(rule.target,'-10080071992547409931234');await f.plugin.listeners[0].handle(f.message(rule.source,77,'hello'),f.context);assert.ok(wire.length>0);
});

test('shift executes complex and catastrophic whitelist patterns only through the SDK worker', async () => {
  const calls=[],f=fixture(create(),{regexp:async(pattern,input,settings)=>{calls.push({pattern,input,settings});return{matched:false,timedOut:true};}});await f.run(['set','@source','@target','text']);await f.run(['whitelist','1','add','(a+)+$']);await f.run(['whitelist','1','enable']);const source=f.state().rules[0].source;await f.plugin.listeners[0].handle(f.message(source,9,'a'.repeat(4000)+'!'),f.context);assert.equal(f.forwards.length,0);assert.deepEqual(calls.map(x=>x.pattern),['(a+)+$']);assert.deepEqual(calls[0].settings,{flags:'i'});
});
test('shift whitelist budget preempts an actually catastrophic expression',async()=>{const regexp=new ScopedSafeRegExp({concurrency:1,queueCapacity:0}),signal=new AbortController().signal,result=await regexp.test('(a+)+$','a'.repeat(4095)+'!',{flags:'i'},signal);assert.equal(result.matched,false);assert.equal(result.timedOut,true);});

test('shift backup status paginates every task instead of silently keeping ten', async () => {
  const f=fixture(),backups={};for(let i=0;i<150;i++)backups[`task-${i}`]={id:`task-${i}`,source:'1',target:'2',order:'desc',status:'completed',processed:i,failed:0,createdAt:1};f.setState({schemaVersion:2,legacyImported:true,rules:[],backups});await f.run(['backup','status']);assert.ok(f.replies.length>0);const output=[f.edits.at(-1),...f.replies].join('\n');assert.match(output,/task-0:/);assert.match(output,/task-149:/);
});
