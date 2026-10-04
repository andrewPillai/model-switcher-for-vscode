'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const manifest = require('../package.json');
const {
  normalizeEndpoint,
  validateProfiles,
  toOpenAIMessages,
  toOpenAITools,
  parseSseBlock,
  connectionError,
  testModelConnection,
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

test('ships friendly model labels without guessing provider model IDs', () => {
  const configPath = path.join(__dirname, '..', 'model-profiles.json');
  const models = JSON.parse(fs.readFileSync(configPath, 'utf8')).models;
  assert.deepEqual(models.map(model => model.name), [
    'Nemotron 3.5 Lightning 30B A3B',
    'Kimi K3',
    'Gemma 4 31B IT',
    ''
  ]);
  assert.ok(models.every(model => model.modelId === ''));
  assert.ok(models.slice(0, 3).every(model => model.endpoint === 'https://integrate.api.nvidia.com/v1/chat/completions'));
  assert.throws(() => validateProfiles(JSON.parse(fs.readFileSync(configPath, 'utf8'))), /exact API modelId/);
});

test('registers every user-facing command for command-palette activation', () => {
  const commands = manifest.contributes.commands.map(command => command.command);
  for (const command of commands) {
    assert.ok(manifest.activationEvents.includes(`onCommand:${command}`), `${command} should activate the extension`);
  }
  assert.ok(commands.includes('nvidia-chat-model-switcher.testModel'));
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

test('translates common provider statuses into actionable diagnostics', () => {
  assert.match(connectionError(401), /Replace the saved key/);
  assert.match(connectionError(403), /model permissions/);
  assert.match(connectionError(404), /exact API model ID/);
  assert.match(connectionError(429), /quota/);
  assert.match(connectionError(503), /server error/);
  assert.match(connectionError(422), /model API compatibility/);
});

test('tests model ID and credentials with a small non-streaming request', async () => {
  let request;
  await testModelConnection({
    fetchImpl: async (url, options) => {
      request = { url, options };
      return Response.json({ choices: [{ message: { content: 'OK' } }] });
    },
    profile: {
      modelId: 'nvidia/nemotron-3-ultra-550b-a55b',
      endpoint: 'https://integrate.api.nvidia.com/v1/chat/completions'
    },
    apiKey: 'unit-test-key'
  });
  const body = JSON.parse(request.options.body);
  assert.equal(request.url, 'https://integrate.api.nvidia.com/v1/chat/completions');
  assert.equal(request.options.headers.authorization, 'Bearer unit-test-key');
  assert.equal(body.model, 'nvidia/nemotron-3-ultra-550b-a55b');
  assert.equal(body.stream, false);
  assert.equal(body.max_tokens, 1);
});

test('test connection reports a wrong model ID with provider-specific guidance', async () => {
  await assert.rejects(testModelConnection({
    fetchImpl: async () => new Response('', { status: 404 }),
    profile: {
      modelId: 'wrong-name-only',
      endpoint: 'https://integrate.api.nvidia.com/v1/chat/completions'
    },
    apiKey: 'unit-test-key'
  }), /exact API model ID/);
});

test('test connection rejects success responses without a chat completion', async () => {
  await assert.rejects(testModelConnection({
    fetchImpl: async () => Response.json({ object: 'list' }),
    profile: {
      modelId: 'some-model',
      endpoint: 'https://example.com/v1/chat/completions'
    },
    apiKey: 'unit-test-key'
  }), /did not contain a chat completion/);
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
