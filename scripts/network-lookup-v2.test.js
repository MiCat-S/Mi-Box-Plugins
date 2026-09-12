'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const core = path.resolve(__dirname, '../../TeleBox-Core');
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const {PluginHost} = require(path.join(core, 'dist/v2/host.js'));

async function fixture(t, id, fetch, client) {
  const {artifactDir} = buildPlugin({id, packageRoot: path.resolve(__dirname, '..', id), entry: 'v2.ts'});
  const create = require(path.join(artifactDir, 'index.cjs')).default;
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `mibot-${id}-`)));
  const edits = [], replies = [], requests = [];
  const host = new PluginHost({storageRoot: root, logger: {info(){}, error(){}}, http: {fetch: async (url, init) => { requests.push({url:new URL(url), init}); return fetch(new URL(url), init); }}, telegram: {
    async edit(message,text,options){edits.push({message,text,options});}, async reply(message,text,options){replies.push({message,text,options});},
    async invoke(){throw new Error('unexpected invoke');}, async getReply(){return undefined;}, async withClient(operation, signal){if(!client)throw new Error('unexpected client');return operation(client,signal);},
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

test('BGP SVG masks decoded addresses and removes IP hyperlink targets before rasterizing', () => {
  const built = buildPlugin({id: 'bgp', packageRoot: path.resolve(__dirname, '../bgp'), entry: 'v2.ts'});
  const {privateGraph} = require(path.join(built.artifactDir, 'index.cjs'));
  const svg = privateGraph('<svg xmlns="http://www.w3.org/2000/svg"><a href="https://38.59.246.201"><text>38&#46;59.246.201</text></a><text>2001:db8::1</text></svg>');
  assert.doesNotMatch(svg, /38\.59\.246\.201|2001:db8::1|href=/);
  assert.match(svg, /38\.59\.\*\.\*/);
});

test('BGP loads its image pipeline on demand and sends a complete PNG before temp cleanup', async t => {
  let file, image;
  const f = await fixture(t, 'bgp', async () => new Response(
    '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="30"><rect width="40" height="30" fill="blue"/></svg>',
    {headers: {'content-type': 'image/svg+xml'}}), {
      async sendFile(_chat, options) { file = options.file; image = await fs.readFile(file); },
    });
  await f.run('.bgp 1.1.1.1');
  assert.ok(image, 'The lazy graph pipeline must reach the media send operation');
  assert.deepEqual(image.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const sharp = require(path.join(core, 'node_modules/sharp'));
  const metadata = await sharp(image).metadata();
  assert.equal(metadata.format, 'png');
  assert.ok(metadata.width > 0 && metadata.width <= 2400);
  assert.ok(metadata.height > 0 && metadata.height <= 1800);
  await assert.rejects(fs.stat(file), {code: 'ENOENT'});
  assert.equal(f.requests.length, 1);
});

function searchHtml(url, title = 'Primary result') {
  return `<div class="result results_links"><a class="result__a" href="//duckduckgo.com/l/?uddg=${encodeURIComponent(url)}">${title}</a><div class="result__snippet">Kept snippet</div></div>`;
}

test('duckduckgo keeps primary results when the optional supplement fails', async t => {
  const f = await fixture(t, 'duckduckgo', async url => {
    if (url.hostname === 'html.duckduckgo.com') return new Response(searchHtml('https://example.com/primary'));
    throw new Error('supplement-secret');
  });
  await f.run('.ddg query');
  assert.match(f.edits.at(-1).text, /Primary result/);
  assert.doesNotMatch(f.edits.at(-1).text, /搜索失败|supplement-secret/);
  assert.equal(f.requests.length, 2);
});

test('duckduckgo preserves encoded URL components through its redirect link', async t => {
  const target = 'https://example.com/search?q=one%26two&next=%252F&text=100%25';
  const f = await fixture(t, 'duckduckgo', async () => new Response(searchHtml(target)));
  await f.run('.ddg -n 1 query');
  const href = f.edits.at(-1).text.match(/href="([^"]+)"/)?.[1].replaceAll('&amp;', '&');
  assert.equal(href, target);
});

test('duckduckgo deduplicates repeated results within its supplement', async t => {
  const f = await fixture(t, 'duckduckgo', async url => url.hostname === 'html.duckduckgo.com'
    ? new Response(searchHtml('https://example.com/primary'))
    : Response.json({data: {web: [
      {url: 'https://example.com/secondary', title: 'Secondary'},
      {url: 'https://example.com/secondary', title: 'Duplicate'},
    ]}}));
  await f.run('.ddg query');
  assert.equal((f.edits.at(-1).text.match(/href="https:\/\/example.com\/secondary"/g) ?? []).length, 1);
});

test('deepwiki keeps every Unicode answer character within Telegram page budgets', async t => {
  const answer = '🙂<&'.repeat(2500);
  const f = await fixture(t, 'deepwiki', async (_url, init) => {
    const body = JSON.parse(init.body);
    if (body.method === 'initialize') return new Response('{}', {headers: {'mcp-session-id': 'local'}});
    if (body.method === 'notifications/initialized') return new Response('', {status: 202});
    return Response.json({result: {content: [{type: 'text', text: answer}]}});
  });
  await f.run('.deepwiki add core https://github.com/owner/repo');
  await f.run('.deepwiki ' + '🚀&'.repeat(600));
  const pages = [f.edits.at(-1).text, ...f.replies.map(item => item.text)];
  for (const page of pages) {
    assert.ok(page.length <= 3500, `HTML page exceeded budget: ${page.length}`);
    assert.equal(page.isWellFormed(), true);
  }
  assert.equal((pages.join('').match(/🙂/gu) ?? []).length, 2500);
  assert.equal((pages.join('').match(/&lt;/g) ?? []).length, 2500);
});

test('deepwiki truncates its answer budget at a complete UTF-16 character', async t => {
  const f = await fixture(t, 'deepwiki', async (_url, init) => {
    const body = JSON.parse(init.body);
    if (body.method === 'initialize') return new Response('{}', {headers: {'mcp-session-id': 'local'}});
    if (body.method === 'notifications/initialized') return new Response('', {status: 202});
    return Response.json({result: {content: [{type: 'text', text: 'x'.repeat(47999) + '😀'}]}});
  });
  await f.run('.deepwiki add core https://github.com/owner/repo');
  await f.run('.deepwiki question');
  const pages = [f.edits.at(-1).text, ...f.replies.map(item => item.text)];
  assert.ok(pages.every(page => page.isWellFormed() && page.length <= 3500));
  assert.equal((pages.join('').match(/x/g) ?? []).length, 47999);
});
