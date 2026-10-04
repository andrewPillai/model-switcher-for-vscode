'use strict';

const { waitForRateLimit } = require('./rate-limiter');

function normalizeEndpoint(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Endpoint must be a valid HTTP or HTTPS URL.');
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('Endpoint must use HTTP or HTTPS.');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('Endpoint cannot contain credentials, a query string, or a fragment.');
  }

  url.pathname = url.pathname.replace(/\/+$/, '');
  if (!url.pathname.endsWith('/chat/completions')) {
    url.pathname = `${url.pathname}/chat/completions`;
  }
  return url.toString();
}

function validateProfiles(value) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.models)) {
    throw new Error('Configuration must contain a "models" array.');
  }
  if (hasCredentialField(value)) {
    throw new Error('Configuration cannot contain API keys or other credentials. Enter keys through the VS Code prompt.');
  }

  const profiles = [];
  const seen = new Set();
  for (const [index, entry] of value.models.entries()) {
    if (!entry || typeof entry !== 'object') {
      throw new Error(`Model ${index + 1} must be an object.`);
    }
    const name = typeof entry.name === 'string' ? entry.name.trim() : '';
    const modelId = typeof entry.modelId === 'string' ? entry.modelId.trim() : '';
    const endpointText = typeof entry.endpoint === 'string' ? entry.endpoint.trim() : '';

    if (!name && !modelId && !endpointText) {
      continue;
    }
    if (!name || !modelId || !endpointText) {
      throw new Error(`Model ${index + 1} needs a name, exact API modelId, and endpoint. Copy the model ID from the provider's API sample, including any provider prefix, or leave all three fields blank to skip this entry.`);
    }
    if (entry.imageInput === true) {
      throw new Error(`Model ${index + 1} enables image input, which this extension does not support yet.`);
    }

    const endpoint = normalizeEndpoint(endpointText);
    const key = `${endpoint}\n${modelId}`;
    if (seen.has(key)) {
      throw new Error(`Model "${modelId}" is listed more than once for the same endpoint.`);
    }
    seen.add(key);

    const rpmLimit = entry.rpmLimit !== undefined ? positiveInteger(entry.rpmLimit, 0) : 0;

    profiles.push({
      id: require('node:crypto').createHash('sha256').update(key).digest('hex').slice(0, 24),
      modelId,
      name,
      endpoint,
      maxInputTokens: positiveInteger(entry.maxInputTokens, 131072),
      maxOutputTokens: positiveInteger(entry.maxOutputTokens, 16384),
      rpmLimit,
      capabilities: {
        toolCalling: entry.toolCalling !== false,
        imageInput: false
      }
    });
  }
  return profiles;
}

function positiveInteger(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function hasCredentialField(value) {
  if (Array.isArray(value)) {
    return value.some(hasCredentialField);
  }
  if (!value || typeof value !== 'object') {
    return false;
  }
  return Object.entries(value).some(([key, entry]) => {
    const normalized = key.toLowerCase().replace(/[^a-z]/g, '');
    return ['apikey', 'key', 'token', 'authorization', 'secret', 'credential'].includes(normalized)
      || hasCredentialField(entry);
  });
}

function contentToText(content, vscode) {
  const parts = [];
  for (const part of content || []) {
    if (part instanceof vscode.LanguageModelTextPart) {
      parts.push(part.value);
    } else if (part instanceof vscode.LanguageModelToolResultPart) {
      parts.push({
        type: 'tool-result',
        callId: part.callId,
        content: contentToText(part.content, vscode).filter(value => typeof value === 'string').join('\n')
      });
    } else if (part instanceof vscode.LanguageModelToolCallPart) {
      parts.push({
        type: 'tool-call',
        callId: part.callId,
        name: part.name,
        input: part.input
      });
    } else if (part && typeof part.value === 'string') {
      parts.push(part.value);
    } else {
      throw new Error('This model request contains an unsupported content type.');
    }
  }
  return parts;
}

function toOpenAIMessages(messages, vscode = require('vscode')) {
  const result = [];
  for (const message of messages) {
    const role = message.role === vscode.LanguageModelChatMessageRole.Assistant
      ? 'assistant'
      : 'user';
    const textParts = [];
    const toolCalls = [];
    const toolResults = [];

    for (const part of contentToText(message.content, vscode)) {
      if (typeof part === 'string') {
        textParts.push(part);
      } else if (part.type === 'tool-call') {
        toolCalls.push({
          id: part.callId,
          type: 'function',
          function: {
            name: part.name,
            arguments: JSON.stringify(part.input)
          }
        });
      } else if (part.type === 'tool-result') {
        toolResults.push({
          role: 'tool',
          tool_call_id: part.callId,
          content: part.content
        });
      }
    }

    const openAIMessage = { role, content: textParts.join('\n') };
    if (toolCalls.length) {
      openAIMessage.tool_calls = toolCalls;
    }
    if (textParts.length || toolCalls.length || !toolResults.length) {
      result.push(openAIMessage);
    }
    result.push(...toolResults);
  }
  return result;
}

function toOpenAITools(tools) {
  if (!tools || tools.length === 0) {
    return undefined;
  }
  return tools.map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema || { type: 'object', properties: {} }
    }
  }));
}

function parseSseBlock(block) {
  const data = block
    .split(/\r?\n/)
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice(5).trim())
    .join('\n');
  if (!data || data === '[DONE]') {
    return undefined;
  }
  try {
    return JSON.parse(data);
  } catch {
    throw new Error('The model endpoint returned an invalid streaming response.');
  }
}

function connectionError(status) {
  if (status === 401) {
    return 'The provider rejected the API key (HTTP 401). Replace the saved key and try again.';
  }
  if (status === 403) {
    return 'The API key does not have access to this model (HTTP 403). Check your provider account and model permissions.';
  }
  if (status === 404) {
    return 'The provider could not find this model or endpoint (HTTP 404). Copy the exact API model ID from the provider sample request, including any required organization or provider prefix.';
  }
  if (status === 429) {
    return 'The provider rate limit or account quota was reached (HTTP 429). Check your provider account and try again later.';
  }
  if (status >= 500) {
    return `The model provider returned a server error (HTTP ${status}). Try again later or check the provider status page.`;
  }
  return `The provider rejected the request (HTTP ${status}). Check the endpoint, model ID, and model API compatibility.`;
}

async function testModelConnection({ fetchImpl = fetch, profile, apiKey, signal }) {
  // Wait for rate limit token before making request
  await waitForRateLimit(profile, signal);
  
  let response;
  try {
    response = await fetchImpl(profile.endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        accept: 'application/json'
      },
      body: JSON.stringify({
        model: profile.modelId,
        messages: [{ role: 'user', content: 'Reply with OK.' }],
        max_tokens: 1,
        stream: false
      }),
      signal
    });
  } catch (error) {
    if (error.name === 'AbortError') {
      throw error;
    }
    throw new Error('Could not reach the model provider. Check your internet connection and endpoint URL.');
  }

  if (!response.ok) {
    throw new Error(connectionError(response.status));
  }
  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error('The endpoint returned a successful status but not a valid JSON chat response. Check that it supports Chat Completions.');
  }
  if (typeof result.choices?.[0]?.message?.content !== 'string') {
    throw new Error('The endpoint response did not contain a chat completion. Check that the model ID supports Chat Completions.');
  }
  return true;
}

async function streamChatCompletion({ fetchImpl = fetch, profile, apiKey, messages, options, progress, token, vscode = require('vscode') }) {
  // Wait for rate limit token before making request
  await waitForRateLimit(profile, token);
  
  const controller = new AbortController();
  const cancellation = token.onCancellationRequested(() => controller.abort());

  try {
    const body = {
      model: profile.modelId,
      messages: toOpenAIMessages(messages, vscode),
      stream: true
    };
    const tools = toOpenAITools(options.tools);
    if (tools) {
      body.tools = tools;
      body.tool_choice = options.toolMode === vscode.LanguageModelChatToolMode.Required
        ? 'required'
        : 'auto';
    }

    const response = await fetchImpl(profile.endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        accept: 'text/event-stream'
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(connectionError(response.status));
    }
    if (!response.body) {
      throw new Error('The model endpoint did not return a streaming response.');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const toolCalls = new Map();
    let buffer = '';

    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      let separator;
      while ((separator = buffer.search(/\r?\n\r?\n/)) !== -1) {
        const block = buffer.slice(0, separator);
        const separatorLength = buffer.slice(separator).startsWith('\r\n\r\n') ? 4 : 2;
        buffer = buffer.slice(separator + separatorLength);
        const event = parseSseBlock(block);
        if (!event) {
          continue;
        }
        const delta = event.choices?.[0]?.delta;
        if (typeof delta?.content === 'string' && delta.content) {
          progress.report(new vscode.LanguageModelTextPart(delta.content));
        }
        for (const call of delta?.tool_calls || []) {
          const state = toolCalls.get(call.index) || { id: '', name: '', arguments: '' };
          if (call.id) state.id = call.id;
          if (call.function?.name) state.name += call.function.name;
          if (call.function?.arguments) state.arguments += call.function.arguments;
          toolCalls.set(call.index, state);
        }
      }
      if (done) {
        break;
      }
    }

    if (buffer.trim()) {
      const event = parseSseBlock(buffer);
      const delta = event?.choices?.[0]?.delta;
      if (typeof delta?.content === 'string' && delta.content) {
        progress.report(new vscode.LanguageModelTextPart(delta.content));
      }
      for (const call of delta?.tool_calls || []) {
        const state = toolCalls.get(call.index) || { id: '', name: '', arguments: '' };
        if (call.id) state.id = call.id;
        if (call.function?.name) state.name += call.function.name;
        if (call.function?.arguments) state.arguments += call.function.arguments;
        toolCalls.set(call.index, state);
      }
    }

    for (const [, call] of [...toolCalls.entries()].sort(([left], [right]) => left - right)) {
      let input;
      try {
        input = JSON.parse(call.arguments || '{}');
      } catch {
        throw new Error(`The model returned invalid arguments for tool "${call.name}".`);
      }
      if (!call.id || !call.name || !input || Array.isArray(input) || typeof input !== 'object') {
        throw new Error('The model returned an incomplete or invalid tool call.');
      }
      progress.report(new vscode.LanguageModelToolCallPart(call.id, call.name, input));
    }
  } catch (error) {
    if (token.isCancellationRequested) {
      return;
    }
    throw error;
  } finally {
    cancellation.dispose();
  }
}

module.exports = {
  normalizeEndpoint,
  validateProfiles,
  toOpenAIMessages,
  toOpenAITools,
  parseSseBlock,
  connectionError,
  testModelConnection,
  streamChatCompletion
};
