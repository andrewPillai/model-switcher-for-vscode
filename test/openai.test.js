'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  normalizeEndpoint,
  validateProfiles,
  toOpenAIMessages,
  toOpenAITools,
  parseSseBlock,
  streamChatCompletion
} = require('../src/openai');

test('normalizes a Chat Completions endpoint without duplicating the path', () => {
  assert.equal(
    normalizeEndpoint('https://integrate.api.nvidia.com/v1/chat/completions'),
    'https://integrate.api.nvidia.com/v1/chat/completions'
  );
  assert.equal(
    normalizeEndpoint('https://example.com/v1/'),
    'https://example.com/v1/chat/completions'
  );
});

test('rejects endpoint credentials and unsafe URL components', () => {
  assert.throws(() => normalizeEndpoint('https://user:pass@example.com/v1'), /credentials/);
  assert.throws(() => normalizeEndpoint('https://example.com/v1?token=secret'), /query string/);
  assert.throws(() => normalizeEndpoint('file:///tmp/model'), /HTTP or HTTPS/);
});

test('validates profiles, ignores empty placeholders, and rejects keys in config', () => {
  const profiles = validateProfiles({
    models: [
      { name: 'Nemotron', modelId: 'nvidia/nemotron', endpoint: 'https://example.com/v1' },
      { name: '', modelId: '', endpoint: '' }
    ]
  });
  assert.equal(profiles.length, 1);
  assert.equal(profiles[0].endpoint, 'https://example.com/v1/chat/completions');
  assert.throws(() => validateProfiles({
    models: [{ name: 'bad', modelId: 'bad', endpoint: 'https://example.com', apiKey: true }]
  }), /cannot contain API keys/);
  assert.throws(() => validateProfiles({
    models: [{ name: 'bad', modelId: 'bad', endpoint: 'https://example.com', metadata: { authorization: 'not-a-key' } }]
  }), /cannot contain API keys/);
  assert.throws(() => validateProfiles({
    models: [
      { name: 'One', modelId: 'same', endpoint: 'https://example.com/v1' },
      { name: 'Two', modelId: 'same', endpoint: 'https://example.com/v1' }
    ]
  }), /more than once/);
});

test('ships the three provided NVIDIA models and a blank slot for the fourth', () => {
  const configPath = path.join(__dirname, '..', 'model-profiles.json');
  const profiles = validateProfiles(JSON.parse(fs.readFileSync(configPath, 'utf8')));
  assert.deepEqual(profiles.map(profile => profile.modelId), [
    'nemotron-3.5-lightning-30b-a3b',
    'kimi-k3',
    'gemma-4-31b-it'
  ]);
  assert.ok(profiles.every(profile => profile.endpoint === 'https://integrate.api.nvidia.com/v1/chat/completions'));
});

test('maps assistant tool calls and tool results to OpenAI chat messages', () => {
  class TextPart {
    constructor(value) { this.value = value; }
  }
  class ToolCallPart {
    constructor(callId, name, input) { Object.assign(this, { callId, name, input }); }
  }
  class ToolResultPart {
    constructor(callId, content) { Object.assign(this, { callId, content }); }
  }
  const vscode = {
    LanguageModelChatMessageRole: { User: 1, Assistant: 2 },
    LanguageModelTextPart: TextPart,
    LanguageModelToolCallPart: ToolCallPart,
    LanguageModelToolResultPart: ToolResultPart
  };
  const messages = toOpenAIMessages([
    {
      role: 2,
      content: [new TextPart('Reading now.'), new ToolCallPart('call-1', 'read_file', { path: 'README.md' })]
    },
    {
      role: 1,
      content: [new ToolResultPart('call-1', [new TextPart('contents')])]
    }
  ], vscode);
  assert.deepEqual(messages, [
    {
      role: 'assistant',
      content: 'Reading now.',
      tool_calls: [{
        id: 'call-1',
        type: 'function',
        function: { name: 'read_file', arguments: '{"path":"README.md"}' }
      }]
    },
    { role: 'tool', tool_call_id: 'call-1', content: 'contents' }
  ]);
});

test('maps available tools to the OpenAI function format', () => {
  assert.deepEqual(toOpenAITools([{
    name: 'search',
    description: 'Search the workspace',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } } }
  }]), [{
    type: 'function',
    function: {
      name: 'search',
      description: 'Search the workspace',
      parameters: { type: 'object', properties: { query: { type: 'string' } } }
    }
  }]);
  assert.equal(toOpenAITools([]), undefined);
});

test('parses SSE data and ignores keepalives and the terminal marker', () => {
  assert.deepEqual(parseSseBlock('event: message\ndata: {"choices":[]}'), { choices: [] });
  assert.equal(parseSseBlock(': keepalive'), undefined);
  assert.equal(parseSseBlock('data: [DONE]'), undefined);
  assert.throws(() => parseSseBlock('data: not-json'), /invalid streaming response/);
});

test('streams text and assembled tool calls using the endpoint model ID', async () => {
  class TextPart {
    constructor(value) { this.value = value; }
  }
  class ToolCallPart {
    constructor(callId, name, input) { Object.assign(this, { callId, name, input }); }
  }
  class ToolResultPart {}
  const vscode = {
    LanguageModelChatMessageRole: { User: 1, Assistant: 2 },
    LanguageModelChatToolMode: { Required: 2 },
    LanguageModelTextPart: TextPart,
    LanguageModelToolCallPart: ToolCallPart,
    LanguageModelToolResultPart: ToolResultPart
  };
  const payload = [
    { choices: [{ delta: { content: 'Hello' } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-2', function: { name: 'search', arguments: '{"query":' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"rates"}' } }] } }] }
  ].map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n';
  let request;
  const reports = [];
  await streamChatCompletion({
    fetchImpl: async (url, options) => {
      request = { url, options };
      return new Response(payload, { status: 200 });
    },
    profile: {
      id: 'internal-profile-id',
      modelId: 'provider/model-x',
      endpoint: 'https://example.com/v1/chat/completions'
    },
    apiKey: 'unit-test-key',
    messages: [{
      role: 1,
      content: [new TextPart('Find rates')]
    }],
    options: {
      tools: [{ name: 'search', description: 'Search', inputSchema: { type: 'object' } }],
      toolMode: 2
    },
    progress: { report: part => reports.push(part) },
    token: {
      isCancellationRequested: false,
      onCancellationRequested: () => ({ dispose() {} })
    },
    vscode
  });

  assert.equal(request.url, 'https://example.com/v1/chat/completions');
  assert.equal(request.options.headers.authorization, 'Bearer unit-test-key');
  const body = JSON.parse(request.options.body);
  assert.equal(body.model, 'provider/model-x');
  assert.equal(body.tool_choice, 'required');
  assert.equal(body.messages[0].content, 'Find rates');
  assert.equal(reports[0].value, 'Hello');
  assert.deepEqual(reports[1], new ToolCallPart('call-2', 'search', { query: 'rates' }));
});

test('surfaces endpoint errors without returning a success-shaped response', async () => {
  await assert.rejects(streamChatCompletion({
    fetchImpl: async () => new Response('', { status: 401 }),
    profile: {
      id: 'profile',
      modelId: 'provider/model-x',
      endpoint: 'https://example.com/v1/chat/completions'
    },
    apiKey: 'unit-test-key',
    messages: [],
    options: { tools: [], toolMode: 1 },
    progress: { report() {} },
    token: {
      isCancellationRequested: false,
      onCancellationRequested: () => ({ dispose() {} })
    },
    vscode: {}
  }), /HTTP 401/);
});
