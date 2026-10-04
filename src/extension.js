'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');
const {
  validateProfiles,
  testModelConnection,
  streamChatCompletion
} = require('./openai');

const vendor = 'nvidia-chat-model-switcher';
const profileStateKey = 'profiles';
const templateName = 'model-profiles.json';
const ollamaDefaultEndpoint = 'http://localhost:11434/v1/chat/completions';
const ollamaModelsEndpoint = 'http://localhost:11434/v1/models';

function secretKey(profile) {
  const fingerprint = crypto
    .createHash('sha256')
    .update(`${profile.endpoint}\n${profile.modelId}`)
    .digest('hex');
  return `apiKey.${fingerprint}`;
}

function activate(context) {
  const emitter = new vscode.EventEmitter();
  context.subscriptions.push(emitter);
  const configPath = path.join(context.globalStorageUri.fsPath, templateName);

  const provider = {
    onDidChangeLanguageModelChatInformation: emitter.event,
    provideLanguageModelChatInformation: async () => {
      const profiles = context.globalState.get(profileStateKey, []);
      const available = [];
      for (const profile of profiles) {
        if (await context.secrets.get(secretKey(profile))) {
          available.push({
            id: profile.id,
            name: profile.name,
            family: profile.modelId.split('/').pop(),
            version: '1',
            tooltip: `${profile.name} · ${new URL(profile.endpoint).host}`,
            detail: new URL(profile.endpoint).host,
            maxInputTokens: profile.maxInputTokens,
            maxOutputTokens: profile.maxOutputTokens,
            capabilities: profile.capabilities
          });
        }
      }
      return available;
    },
    provideLanguageModelChatResponse: async (model, messages, options, progress, token) => {
      const profiles = context.globalState.get(profileStateKey, []);
      const profile = profiles.find(candidate => candidate.id === model.id);
      if (!profile) {
        throw new Error('This model is no longer configured. Run "Model Switcher: Apply Model Configuration", then select the updated model in a new chat.');
      }
      const apiKey = await context.secrets.get(secretKey(profile));
      if (!apiKey) {
        throw new Error(`No API key is saved for ${profile.name}. Reapply the model configuration to add one.`);
      }

      await streamChatCompletion({
        profile,
        apiKey,
        messages,
        options,
        progress,
        token
      });
    },
    provideTokenCount: async (_model, text) => {
      const value = typeof text === 'string'
        ? text
        : JSON.stringify(text);
      return Math.ceil(value.length / 4);
    }
  };

  context.subscriptions.push(
    vscode.lm.registerLanguageModelChatProvider(vendor, provider),
    vscode.commands.registerCommand('nvidia-chat-model-switcher.openConfig', () => openConfig(context, configPath)),
    vscode.commands.registerCommand('nvidia-chat-model-switcher.applyConfig', () => applyConfig(context, configPath, emitter)),
    vscode.commands.registerCommand('nvidia-chat-model-switcher.testModel', () => testConfiguredModel(context)),
    vscode.commands.registerCommand('nvidia-chat-model-switcher.detectOllama', () => detectAndConfigureOllama(context, configPath, emitter))
  );
  ensureConfigFile(context, configPath).catch(error => {
    vscode.window.showErrorMessage(`Could not create the model configuration file: ${error.message}`);
  });
}

async function ensureConfigFile(context, configPath) {
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  try {
    await fs.access(configPath);
  } catch {
    const bundledTemplate = path.join(context.extensionPath, templateName);
    await fs.copyFile(bundledTemplate, configPath);
  }
}

async function openConfig(context, configPath) {
  try {
    await ensureConfigFile(context, configPath);
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(configPath));
    await vscode.window.showTextDocument(document);
  } catch (error) {
    vscode.window.showErrorMessage(`Could not open the model configuration: ${error.message}`);
  }
}

async function applyConfig(context, configPath, emitter) {
  try {
    await ensureConfigFile(context, configPath);
    const source = await fs.readFile(configPath, 'utf8');
    let parsed;
    try {
      parsed = JSON.parse(source);
    } catch (error) {
      throw new Error(`Model configuration is not valid JSON: ${error.message}`);
    }
    const profiles = validateProfiles(parsed);
    if (profiles.length === 0) {
      throw new Error('Add at least one model with a name, exact model ID, and endpoint.');
    }

    const credentials = [];
    for (const profile of profiles) {
      let apiKey = await context.secrets.get(secretKey(profile));
      if (apiKey) {
        const action = await vscode.window.showQuickPick(
          ['Keep saved API key', 'Replace saved API key'],
          { title: `API key for ${profile.name}` }
        );
        if (!action) {
          return;
        }
        if (action === 'Keep saved API key') {
          credentials.push({ profile, apiKey });
          continue;
        }
        apiKey = undefined;
      }
      if (!apiKey) {
        apiKey = await vscode.window.showInputBox({
          title: `API key for ${profile.name}`,
          prompt: `Saved securely in VS Code; it will not be written to ${templateName}.`,
          password: true,
          ignoreFocusOut: true,
          validateInput: value => value.trim() ? undefined : 'Enter an API key, or press Escape to cancel.'
        });
        if (apiKey === undefined) {
          return;
        }
      }
      credentials.push({ profile, apiKey });
    }

    const previous = context.globalState.get(profileStateKey, []);
    const nextSecretKeys = new Set(profiles.map(secretKey));
    for (const { profile, apiKey } of credentials) {
      await context.secrets.store(secretKey(profile), apiKey);
    }
    await context.globalState.update(profileStateKey, profiles);
    emitter.fire();
    let cleanupFailures = 0;
    for (const oldProfile of previous) {
      const oldKey = secretKey(oldProfile);
      if (!nextSecretKeys.has(oldKey)) {
        try {
          await context.secrets.delete(oldKey);
        } catch {
          cleanupFailures += 1;
        }
      }
    }
    if (cleanupFailures) {
      vscode.window.showWarningMessage(`Configured ${profiles.length} model${profiles.length === 1 ? '' : 's'}, but could not remove ${cleanupFailures} unused saved API key${cleanupFailures === 1 ? '' : 's'}.`);
      return;
    }
    const changedModels = previous.some(oldProfile => {
      const current = profiles.find(profile => profile.id === oldProfile.id);
      return !current || current.modelId !== oldProfile.modelId || current.endpoint !== oldProfile.endpoint;
    });
    const guidance = changedModels
      ? 'Model IDs or endpoints changed. Start a new chat and reselect a model to clear any stale selection.'
      : 'Select a model from the Chat picker. Use "Model Switcher: Test Model Connection" to verify its ID, endpoint, and API key first.';
    vscode.window.showInformationMessage(`Configured ${profiles.length} API model${profiles.length === 1 ? '' : 's'}. ${guidance}`);
  } catch (error) {
    vscode.window.showErrorMessage(`Could not apply model configuration: ${error.message}`);
  }
}

async function testConfiguredModel(context) {
  try {
    const profiles = context.globalState.get(profileStateKey, []);
    const available = [];
    for (const profile of profiles) {
      if (await context.secrets.get(secretKey(profile))) {
        available.push({
          label: profile.name,
          description: profile.modelId,
          detail: new URL(profile.endpoint).host,
          profile
        });
      }
    }
    if (!available.length) {
      vscode.window.showWarningMessage('No models with saved API keys are configured. Run "Model Switcher: Apply Model Configuration" first.');
      return;
    }

    const selected = await vscode.window.showQuickPick(available, {
      title: 'Choose a model to test',
      placeHolder: 'A short test request will be sent to the provider.'
    });
    if (!selected) {
      return;
    }
    const confirmed = await vscode.window.showWarningMessage(
      `Send a small test request to ${selected.profile.name}? The provider may charge for this request.`,
      { modal: true },
      'Send test request'
    );
    if (confirmed !== 'Send test request') {
      return;
    }

    const apiKey = await context.secrets.get(secretKey(selected.profile));
    if (!apiKey) {
      throw new Error(`No API key is saved for ${selected.profile.name}. Reapply the configuration to add one.`);
    }
    await testModelConnection({ profile: selected.profile, apiKey });
    vscode.window.showInformationMessage(`${selected.profile.name} responded successfully. Its model ID, endpoint, and API key are working.`);
  } catch (error) {
    vscode.window.showErrorMessage(`Model connection test failed: ${error.message}`);
  }
}

async function detectAndConfigureOllama(context, configPath, emitter) {
  try {
    // Check if Ollama is running
    let modelsResponse;
    try {
      const response = await fetch(ollamaModelsEndpoint);
      if (!response.ok) {
        throw new Error(`Ollama responded with ${response.status}`);
      }
      modelsResponse = await response.json();
    } catch (error) {
      const action = await vscode.window.showErrorMessage(
        'Could not connect to Ollama at http://localhost:11434. Is Ollama running?',
        'Open Ollama Website',
        'Retry'
      );
      if (action === 'Open Ollama Website') {
        vscode.env.openExternal(vscode.Uri.parse('https://ollama.com'));
      } else if (action === 'Retry') {
        return detectAndConfigureOllama(context, configPath, emitter);
      }
      return;
    }

    const models = modelsResponse.data || [];
    if (!models.length) {
      vscode.window.showInformationMessage('No models found in Ollama. Pull a model first with `ollama pull <model>`.');
      return;
    }

    // Let user select which models to add
    const modelItems = models.map(model => ({
      label: model.id,
      description: `Owned by: ${model.owned_by || 'unknown'}`,
      modelId: model.id,
      picked: false
    }));

    const selected = await vscode.window.showQuickPick(modelItems, {
      title: 'Select Ollama models to add to Model Switcher',
      placeHolder: 'Pick one or more models (use checkboxes)',
      canPickMany: true
    });

    if (!selected || !selected.length) {
      return;
    }

    // Read existing config
    await ensureConfigFile(context, configPath);
    let existingProfiles = [];
    try {
      const source = await fs.readFile(configPath, 'utf8');
      const parsed = JSON.parse(source);
      existingProfiles = validateProfiles(parsed);
    } catch {
      // Config might be empty or invalid, start fresh
    }

    // Build new profiles for selected models
    const newProfiles = selected.map(item => {
      // Generate a friendly name
      const name = item.modelId
        .replace(/[:/]/g, ' ')
        .replace(/-/g, ' ')
        .replace(/\b\w/g, c => c.toUpperCase());

      return {
        name: `${name} (Ollama)`,
        modelId: item.modelId,
        endpoint: ollamaDefaultEndpoint,
        rpmLimit: 0
      };
    });

    // Merge with existing (avoid duplicates by modelId + endpoint)
    const merged = [...existingProfiles];
    for (const newProfile of newProfiles) {
      const exists = merged.some(p => 
        p.modelId === newProfile.modelId && p.endpoint === newProfile.endpoint
      );
      if (!exists) {
        merged.push(newProfile);
      }
    }

    // Write back to config file
    const configContent = { models: merged };
    await fs.writeFile(configPath, JSON.stringify(configContent, null, 2));

    // Apply configuration (will prompt for API keys - user can press Escape for Ollama)
    await applyConfig(context, configPath, emitter);

    vscode.window.showInformationMessage(
      `Added ${selected.length} Ollama model${selected.length === 1 ? '' : 's'}. ` +
      'No API key needed for local Ollama - press Escape when prompted.'
    );
  } catch (error) {
    vscode.window.showErrorMessage(`Failed to detect Ollama models: ${error.message}`);
  }
}

function deactivate() {}

module.exports = {
  activate,
  deactivate,
  secretKey
};
