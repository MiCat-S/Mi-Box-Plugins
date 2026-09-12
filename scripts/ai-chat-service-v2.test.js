'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const core = path.resolve(__dirname, '../../TeleBox-Core');
const {buildPlugin} = require(path.join(core, 'scripts/build-v2-plugin.cjs'));
const {artifactDir} = buildPlugin({id: 'ai', packageRoot: path.resolve(__dirname, '../ai'), entry: 'v2.ts'});
const createAi = require(path.join(artifactDir, 'index.cjs')).default;

function config(overrides = {}) {
  return {
    configs: {
      main: {tag: 'main', url: 'https://main.invalid/v1', key: 'main-key', stream: false, responses: false, type: 'openai-compatible'},
      alt: {tag: 'alt', url: 'https://alt.invalid/v1', key: 'alt-key', stream: false, responses: false, type: 'openai-compatible'},
    },
    currentChatTag: 'main', currentChatModel: 'model-main',
    currentChatReasoningEffort: 'high', currentChatServiceTier: 'auto',
    currentSearchTag: 'main', currentSearchModel: 'model-main',
    currentSearchReasoningEffort: 'auto', currentSearchServiceTier: 'auto',
    currentImageTag: '', currentImageModel: '', currentVideoTag: '', currentVideoModel: '',
    imagePreview: true, videoPreview: true, videoAudio: false, videoDuration: 5,
    prompt: '', collapse: true, timeout: 30, telegraphToken: '', telegraph: {enabled: false, limit: 5, list: []},
    ...overrides,
  };
}

async function callChat(cfg, input) {
  const definition = createAi();
  const requests = [];
  const controller = new AbortController();
  const context = {
    signal: controller.signal,
    storage: {json: () => ({read: async () => cfg})},
    http: {withResponse: async (url, init, consume) => {
      requests.push({url: String(url), init});
      return consume(new Response(JSON.stringify({choices: [{message: {content: 'ok'}}]}), {status: 200}), controller.signal);
    }},
    telegram: {edit: async () => {}, reply: async () => {}},
  };
  const result = await definition.services.chat.handle(input, context, controller.signal);
  return {result, requests};
}

test('ai chat service applies provider, model and reasoning overrides', async () => {
  const {result, requests} = await callChat(config(), {text: 'hi', systemPrompt: 'sys', tag: 'alt', model: 'model-alt', reasoningEffort: 'none'});
  assert.equal(result, 'ok');
  assert.match(requests[0].url, /alt\.invalid/);
  const body = JSON.parse(requests[0].init.body);
  assert.equal(body.model, 'model-alt');
  assert.equal(body.reasoning_effort, 'none');
  assert.equal(body.messages[0].content, 'sys');
});

test('ai chat service keeps configured defaults without overrides', async () => {
  const cfg = config();
  cfg.configs.main.models = {chat: 'stale-provider-model'};
  const {requests} = await callChat(cfg, {text: 'hi'});
  assert.match(requests[0].url, /main\.invalid/);
  const body = JSON.parse(requests[0].init.body);
  assert.equal(body.model, 'model-main');
  assert.equal(body.reasoning_effort, 'high');
});

test('ai chat service adds the standard v1 prefix to a root OpenAI provider URL', async () => {
  const cfg = config();
  cfg.configs.main.url = 'https://main.invalid';
  const {requests} = await callChat(cfg, {text: 'hi'});
  assert.equal(new URL(requests[0].url).pathname, '/v1/chat/completions');
});

test('ai chat service uses the requested provider model and accepts bounded multimodal options', async () => {
  const cfg = config();
  cfg.configs.alt.models = {chat: 'alt-chat-model'};
  const {requests} = await callChat(cfg, {text: 'describe', tag: 'alt', temperature: 0.4, maxOutputTokens: 321,
    images: [{mimeType: 'image/png', data: Buffer.from('png')}]});
  const body = JSON.parse(requests[0].init.body);
  assert.equal(body.model, 'alt-chat-model');
  assert.equal(body.temperature, 0.4);
  assert.equal(body.max_tokens, 321);
  assert.match(body.messages.at(-1).content[1].image_url.url, /^data:image\/png;base64,/);
});

test('ai chat service rejects unknown providers and invalid reasoning effort', async () => {
  await assert.rejects(callChat(config(), {text: 'hi', tag: 'missing'}), /提供商/);
  await assert.rejects(callChat(config(), {text: 'hi', tag: 'alt'}), /配置 ai chat 模型/);
  await assert.rejects(callChat(config(), {text: 'hi', reasoningEffort: 'bogus'}), /思考强度/);
  await assert.rejects(callChat(config(), {text: 'hi', model: '   '}), /模型/);
});

test('ai selection service exposes current chat/search choices without secrets', async () => {
  const definition = createAi();
  const controller = new AbortController();
  const cfg = config({currentSearchTag: 'alt', currentSearchModel: 'model-search'});
  const context = {signal: controller.signal, storage: {json: () => ({read: async () => cfg})}};
  const selection = await definition.services.selection.handle(null, context, controller.signal);
  assert.deepEqual(selection.chat, {tag: 'main', model: 'model-main', reasoningEffort: 'high', serviceTier: 'auto'});
  assert.deepEqual(selection.search, {tag: 'alt', model: 'model-search', reasoningEffort: 'auto', serviceTier: 'auto'});
  assert.deepEqual(selection.image, {tag: '', model: ''});
  assert.deepEqual(selection.video, {tag: '', model: ''});
  assert.deepEqual(selection.providers.map(item => item.tag), ['alt', 'main']);
  assert.equal(JSON.stringify(selection).includes('key'), false);
});

function mutableContext(initial, responder = () => Response.json({})) {
  let state = structuredClone(initial);
  const controller = new AbortController();
  const requests = [];
  const context = {signal: controller.signal,
    storage: {json: () => ({async read() {return structuredClone(state);}, async update(change) {
      state = await change(structuredClone(state)); return structuredClone(state);
    }})},
    http: {async withResponse(url, init, consume) {
      requests.push({url: String(url), init}); return consume(await responder(new URL(url), init), controller.signal);
    }},
    telegram: {async edit() {}, async reply() {}},
  };
  return {context, signal: controller.signal, requests, state: () => structuredClone(state)};
}

test('ai import service resolves tag collisions, is idempotent, and selects the actual imported tag once', async () => {
  const cfg = config({configs: {banana: {tag: 'banana', url: 'https://occupied.invalid/v1', key: 'occupied',
    type: 'openai-compatible', stream: false, responses: false, models: {image: 'other'}}},
    currentImageTag: '', currentImageModel: ''});
  const fixture = mutableContext(cfg); const service = createAi().services.import_provider;
  const input = {tag: 'banana', url: 'https://generativelanguage.googleapis.com/v1beta', key: 'legacy',
    type: 'gemini', models: {image: 'gemini-image'}, select: ['image']};
  assert.deepEqual(await service.handle(input, fixture.context, fixture.signal), {tag: 'banana-2', imported: true});
  assert.deepEqual(await service.handle(input, fixture.context, fixture.signal), {tag: 'banana-2', imported: false});
  const saved = fixture.state();
  assert.equal(saved.configs.banana.key, 'occupied');
  assert.equal(saved.configs['banana-2'].key, 'legacy');
  assert.equal(saved.currentImageTag, 'banana-2');
  assert.equal(saved.currentImageModel, 'gemini-image');
  assert.equal(Object.keys(saved.configs).length, 2);

  const shared = config({configs: {shared: {tag: 'shared', url: 'https://shared.invalid/v1', key: 'shared-key',
    type: 'openai-compatible', stream: false, responses: false, models: {chat: 'registered-model'}}},
    currentChatTag: '', currentChatModel: ''});
  const existing = mutableContext(shared);
  await service.handle({tag: 'shared', url: 'https://shared.invalid/v1', key: 'shared-key', type: 'openai-compatible',
    models: {chat: 'legacy-model'}, select: ['chat']}, existing.context, existing.signal);
  assert.equal(existing.state().currentChatTag, 'shared');
  assert.equal(existing.state().currentChatModel, 'registered-model');
});

test('ai models service normalizes official provider roots and keeps credentials out of output', async () => {
  const cfg = config({configs: {
    openai: {tag: 'openai', url: 'https://api.openai.com', key: 'openai-secret', type: 'openai', stream: false, responses: false},
    gemini: {tag: 'gemini', url: 'https://generativelanguage.googleapis.com', key: 'gemini-secret', type: 'gemini', stream: false, responses: false},
  }});
  const fixture = mutableContext(cfg, target => Response.json(target.hostname.includes('google')
    ? {models: [{name: 'models/gemini-test'}]} : {data: [{id: 'gpt-test'}]}));
  const service = createAi().services.models;
  assert.deepEqual(await service.handle({tag: 'openai'}, fixture.context, fixture.signal), ['gpt-test']);
  assert.deepEqual(await service.handle({tag: 'gemini'}, fixture.context, fixture.signal), ['models/gemini-test']);
  assert.equal(new URL(fixture.requests[0].url).pathname, '/v1/models');
  assert.equal(new URL(fixture.requests[1].url).pathname, '/v1beta/models');
  assert.equal(new URL(fixture.requests[1].url).searchParams.get('key'), 'gemini-secret');
});

test('ai image service returns generated bytes through the current unified image selection', async () => {
  const output = Buffer.from('generated-image');
  const cfg = config({configs: {image: {tag: 'image', url: 'https://generativelanguage.googleapis.com/v1beta', key: 'key',
    type: 'gemini', stream: false, responses: false, models: {image: 'gemini-image'}}},
    currentImageTag: 'image', currentImageModel: 'gemini-image'});
  const fixture = mutableContext(cfg, () => Response.json({candidates: [{content: {parts: [{inlineData: {
    mimeType: 'image/png', data: output.toString('base64'),
  }}]}}]}));
  const result = await createAi().services.image.handle({prompt: 'draw'}, fixture.context, fixture.signal);
  assert.deepEqual(Buffer.from(result[0].data), output);
  assert.equal(result[0].mimeType, 'image/png');
});

test('ai image service parses Codex CRLF SSE and a terminal frame without a blank line', async () => {
  const output = Buffer.from('codex-image');
  const cfg = config({configs: {codex: {tag: 'codex', url: 'https://chatgpt.com/backend-api/codex/responses', key: 'token',
    type: 'codex', stream: false, responses: false, models: {image: 'gpt-5.4'}}},
    currentImageTag: 'codex', currentImageModel: 'gpt-5.4'});
  const fixture = mutableContext(cfg, () => new Response(
    `data: ${JSON.stringify({response: {id: 'resp_1', status: 'in_progress'}})}\r\n\r\ndata: ${JSON.stringify({partial_image_b64: output.toString('base64')})}`,
    {headers: {'content-type': 'text/event-stream'}}));
  const result = await createAi().services.image.handle({prompt: 'draw'}, fixture.context, fixture.signal);
  assert.deepEqual(Buffer.from(result[0].data), output);
  assert.equal(new URL(fixture.requests[0].url).pathname, '/backend-api/codex/responses');
  assert.equal(fixture.requests[0].init.headers.Authorization, 'Bearer token');
});
