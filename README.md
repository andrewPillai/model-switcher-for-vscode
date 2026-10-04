# NVIDIA Chat Model Switcher

A VS Code extension that adds OpenAI Chat Completions-compatible models to the
Chat model picker. Model IDs and endpoints are configured in a JSON file. API
keys are entered in a secure VS Code prompt and stored in VS Code SecretStorage,
never in the JSON file.

## Install

1. Download the latest
   [NVIDIA Chat Model Switcher VSIX](https://github.com/andrewPillai/nvidia-extension-installer/releases/latest).
2. In the VS Code desktop app, open **Extensions → … → Install from VSIX…**
   and select the downloaded `.vsix` file.
3. If the extension's commands do not appear after installation, enable it for
   the Default profile from macOS Terminal:

   ```sh
   "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" \
     --enable-extension local-development.nvidia-chat-model-switcher \
     --profile "Default"
   ```

   Then quit VS Code with **⌘Q**, reopen it, and use **F1** (or **fn+F1**) to
   find the extension commands. In VS Code, check **Profiles: Switch Profile**
   if you use a profile other than Default. A locally installed extension also
   needs to be installed in the remote environment when using SSH or Codespaces.

## Configure and verify

1. Run **NVIDIA Chat Models: Open Model Configuration** from the Command
   Palette.
2. For each model you want to use, set:
   - `name`: any friendly label for the model picker.
   - `modelId`: copy the exact API model ID from the provider's sample request
     (`"model": "..."`). Include the provider prefix if shown, for example
     `nvidia/nemotron-3-ultra-550b-a55b`. A display name by itself is not
     necessarily the API model ID.
   - `endpoint`: the full Chat Completions URL. NVIDIA NIM uses
     `https://integrate.api.nvidia.com/v1/chat/completions`. A base URL ending
     in `/v1` is also accepted; the extension adds `/chat/completions`.
3. Delete any unused, partially filled starter rows (or fill all three fields).
   Save the file.
4. Run **NVIDIA Chat Models: Apply Model Configuration**. Enter API keys in
   VS Code's password prompt. Do not add keys to the configuration file.
5. Run **NVIDIA Chat Models: Test Model Connection**, choose a model, and
   confirm the small test request. The request uses one output token and may
   incur a small charge from the model provider. A successful test verifies
   the model ID, endpoint, and API key before you select the model in Chat.
6. Select the model from the Chat model picker. If you changed a model ID or
   endpoint, start a **new chat** and select the updated model again to clear a
   stale selection.

The endpoint must support streaming OpenAI Chat Completions for normal chat,
including tool calls for agent mode. Provider-specific APIs such as Anthropic
Messages are not supported unless the provider also exposes a compatible
Chat Completions endpoint.

## Common errors

The **Test Model Connection** command gives actionable messages for common
provider responses:

- **401**: the API key was rejected; replace the saved key.
- **403**: the key lacks permission to use that model.
- **404**: the model ID or endpoint was not found; verify the exact API model
  ID, including any provider prefix.
- **429**: a rate limit or account quota was reached.
- **5xx**: the provider returned a server error; retry later.

If a model-selection error says a model is unavailable after you edit its ID,
open a new chat and select the updated model from the picker.

## Build and test

```sh
npm install
npm test
npm run package
```

The VSIX is written to this directory. Never commit API keys or place them in
`model-profiles.json`, source code, or chat messages.
