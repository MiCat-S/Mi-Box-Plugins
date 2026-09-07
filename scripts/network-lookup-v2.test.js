'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const core = path.resolve(__dirname, '../../TeleBox-Core');
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const {PluginHost} = require(path.join(core, 'dist/v2/host.js'));

async function fixture(t, id, fetch) {
  const {artifactDir} = buildPlugin({id, packageRoot: path.resolve(__dirname, '..', id), entry: 'v2.ts'});
  const create = require(path.join(artifactDir, 'index.cjs')).default;
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `mibot-${id}-`)));
  const edits = [], replies = [], requests = [];
  const host = new PluginHost({storageRoot: root, logger: {info(){}, error(){}}, http: {fetch: async (url, init) => { requests.push({url:new URL(url), init}); return fetch(new URL(url), init); }}, telegram: {
    async edit(message,text,options){edits.push({message,text,options});}, async reply(message,text,options){replies.push({message,text,options});},
    async invoke(){throw new Error('unexpected invoke');}, async getReply(){return undefined;}, async withClient(){throw new Error('unexpected client');},
  }});
  await host.load(create());
  t.after(async()=>{assert.equal((await host.shutdown(1000)).completed,true);await fs.rm(root,{recursive:true,force:true});});
  return {edits,replies,requests,run:text=>host.dispatchPrimary({id:1,chatId:'100',senderId:'1',outgoing:true,text})};
}

test('duckduckgo validates arguments and parses bounded HTML results', async t => {
  const html = `<div class="result results_links"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fx">Example &amp; result</a><div class="result__snippet">Safe snippet</div></div>`;
  const f=await fixture(t,'duckduckgo',async url=>url.hostname==='html.duckduckgo.com'?new Response(html):Response.json({data:{web:[]}}));
  await f.run('.ddg -n 1 hello');
  assert.match(f.edits.at(-1).text,/Example &amp; result/);
  assert.equal(f.requests[0].init.redirect,'manual');
  assert.equal(f.requests[0].init.signal instanceof AbortSignal,true);
  const before=f.requests.length; await f.run(`.ddg ${'x'.repeat(201)}`); assert.equal(f.requests.length,before);
});

test('deepwiki persists projects and performs a bounded MCP exchange', async t => {
  let calls=0;
  const f=await fixture(t,'deepwiki',async (_url,init)=>{calls++;const body=JSON.parse(init.body);if(body.method==='initialize')return new Response(JSON.stringify({jsonrpc:'2.0',id:1,result:{protocolVersion:'2025-03-26'}}),{headers:{'content-type':'application/json','mcp-session-id':'session-1'}});if(body.method==='notifications/initialized')return new Response('',{status:202});return new Response(JSON.stringify({jsonrpc:'2.0',id:2,result:{content:[{type:'text',text:'Answer **safe**'}]}}),{headers:{'content-type':'application/json','mcp-session-id':'session-1'}});});
  await f.run('.deepwiki add core https://github.com/owner/repo');
  await f.run('.deepwiki lst'); assert.match(f.edits.at(-1).text,/owner\/repo/);
  await f.run('.deepwiki question'); assert.match(f.edits.at(-1).text,/Answer \*\*safe\*\*/); assert.equal(calls,3);
  assert.equal(f.requests.every(x=>x.init.redirect==='manual'),true);
});

test('deepwiki paginates long Unicode answers without splitting HTML entities', async t => {
  const answer='🙂<&'.repeat(1200);
  const f=await fixture(t,'deepwiki',async (_url,init)=>{const body=JSON.parse(init.body);if(body.method==='initialize')return new Response('{}',{headers:{'mcp-session-id':'session-1'}});if(body.method==='notifications/initialized')return new Response('',{status:202});return Response.json({result:{content:[{type:'text',text:answer}]}});});
  await f.run('.deepwiki add core https://github.com/owner/repo');
  await f.run('.deepwiki question');
  const output=[...f.edits.slice(-1),...f.replies].map(x=>x.text).join('');
  assert.equal((output.match(/🙂/gu)||[]).length,1200);
  assert.equal((output.match(/&lt;/g)||[]).length,1200);
  assert.equal((output.match(/&amp;/g)||[]).length,1200);
  assert.doesNotMatch(output,/&(?:a|am|amp|l|lt)?$/);
});

test('bgp DNS uses /24 first and filters noisy root domains', async t => {
  const f=await fixture(t,'bgp',async()=>new Response(`<p>1.1.1.1 one.example.com 1.1.1.2 two.example.com 1.1.1.3 three.example.com 1.0.0.1 one.test.net</p>`));
  await f.run('.bgp dns 1.1.1.1');
  assert.match(f.requests[0].url.pathname,/1\.1\.1\.0\/24/);
  assert.match(f.edits.at(-1).text,/one\.test\.net/);
  assert.doesNotMatch(f.edits.at(-1).text,/one\.example\.com/);
});

test('ntp reads a server date through controlled HTTP and rejects unknown mode', async t => {
  const f=await fixture(t,'ntp',async()=>new Response(null,{status:200,headers:{date:new Date().toUTCString()}}));
  await f.run('.ntp'); assert.match(f.edits.at(-1).text,/时间查询完成/); assert.equal(f.requests[0].init.method,'HEAD'); assert.equal(f.requests[0].init.redirect,'manual');
  const before=f.requests.length;await f.run('.ntp nope');assert.equal(f.requests.length,before);assert.match(f.edits.at(-1).text,/NTP 对时/);
});

test('network plugin errors are redacted', async t => {
  const f=await fixture(t,'duckduckgo',async()=>{throw new Error('secret-token');});
  await f.run('.ddg query');
  assert.doesNotMatch(f.edits.at(-1).text,/secret-token/);
});

test('fixed-host redirects are rejected before contacting another origin', async t => {
  let calls=0;
  const f=await fixture(t,'duckduckgo',async()=>{calls++;return new Response('',{status:302,headers:{location:'https://attacker.invalid/secret'}});});
  await f.run('.ddg query');
  assert.equal(calls,1);
  assert.equal(f.requests.every(request=>request.url.hostname!=='attacker.invalid'),true);
  assert.match(f.edits.at(-1).text,/搜索失败/);
});
