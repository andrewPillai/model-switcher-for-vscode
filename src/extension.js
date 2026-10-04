'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');
const {
  validateProfiles,
  streamChatCompletion
} = require('./openai');

const vendor = 'nvidia-chat-model-switcher';
const profileStateKey = 'profiles';
const templateName = 'model-profiles.json';

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
        throw new Error('This model is no longer configured. Run "NVIDIA Chat Models: Apply Model Configuration".');
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
    vscode.commands.registerCommand('nvidia-chat-model-switcher.applyConfig', () => applyConfig(context, configPath, emitter))
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
    vscode.window.showInformationMessage(`Configured ${profiles.length} API model${profiles.length === 1 ? '' : 's'}. Select one from the Chat model picker.`);
  } catch (error) {
    vscode.window.showErrorMessage(`Could not apply model configuration: ${error.message}`);
  }
}

function deactivate() {}

module.exports = {
  activate,
  deactivate,
  secretKey
};
