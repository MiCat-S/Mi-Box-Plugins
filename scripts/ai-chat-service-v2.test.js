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
  const {requests} = await callChat(config(), {text: 'hi'});
  assert.match(requests[0].url, /main\.invalid/);
  const body = JSON.parse(requests[0].init.body);
  assert.equal(body.model, 'model-main');
  assert.equal(body.reasoning_effort, 'high');
});

test('ai chat service rejects unknown providers and invalid reasoning effort', async () => {
  await assert.rejects(callChat(config(), {text: 'hi', tag: 'missing'}), /提供商/);
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
  assert.equal(JSON.stringify(selection).includes('key'), false);
});
