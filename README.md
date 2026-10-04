# Model Switcher for VS Code

Add your own API-backed models to the VS Code Chat model picker. Set a model
name, its exact provider API model ID, and an endpoint; the API key is entered
separately and stored in VS Code's secure SecretStorage.

## Compatibility

The model endpoint must implement the **OpenAI-compatible Chat Completions
API**, including streaming for normal chat. Tool calling is supported when the
provider and model support OpenAI-style function tools. You can use compatible
cloud providers, gateways, or self-hosted endpoints; a key and a model name
alone are not enough if the provider uses an incompatible native API.

Anthropic Messages, Google Gemini's native API, and other provider-specific
protocols are not supported unless your provider also offers an
OpenAI-compatible Chat Completions endpoint.

## Install

1. Download the latest [Model Switcher for VS Code VSIX](https://github.com/andrewPillai/model-switcher-for-vscode/releases/latest).
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
   find the **Model Switcher** commands. Check **Profiles: Switch Profile** if
   you use a profile other than Default. In an SSH or Codespaces window, the
   extension must also be installed in the remote environment.

## Configure and verify

1. Run **Model Switcher: Open Model Configuration** from the Command Palette.
2. For every model you want to add, fill in:
   - `name`: a friendly label shown in the model picker.
   - `modelId`: the exact model identifier from your provider's API sample,
     copied from the value of `"model": "..."`. Include any required prefix.
     The human-readable product name may not be the API model ID.
   - `endpoint`: the provider's OpenAI-compatible Chat Completions URL. A full
     URL such as `https://api.example.com/v1/chat/completions` or a base URL
     ending in `/v1` is accepted.
   - `rpmLimit` (optional): maximum requests per minute for this endpoint.
     - For **NVIDIA NIM free tier**, this is **automatically set to 40 RPM** (hard limit).
     - For other providers, set your desired limit (e.g., `60`, `100`) or omit/`0` for unlimited.
3. Leave an unused row completely blank or remove it; partially completed rows
   are rejected. Duplicate rows in the `models` array to add more models.
4. Save the file and run **Model Switcher: Apply Model Configuration**. Enter
   the API key in VS Code's password prompt. **Do not add keys to the JSON file.**
5. Run **Model Switcher: Test Model Connection**, select a model, and confirm
   the small test request. It uses one output token and may incur a small
   provider charge. A successful test checks the model ID, endpoint, and key
   before you select that model in Chat.
6. Select the model from Chat's model picker. After changing a model ID or
   endpoint, start a **new chat** and select the updated model to clear stale
   selections.

Example entry (replace these example values with your provider's details):

```json
{
  "name": "My hosted model",
  "modelId": "provider/model-id-from-api-example",
  "endpoint": "https://api.example.com/v1/chat/completions",
  "rpmLimit": 60
}
```

Example NVIDIA NIM entry (40 RPM is enforced automatically):

```json
{
  "name": "Nemotron 3 Ultra",
  "modelId": "nvidia/nemotron-3-ultra",
  "endpoint": "https://integrate.api.nvidia.com/v1/chat/completions"
  // rpmLimit is automatically set to 40 for NVIDIA NIM endpoints
}
```

## Troubleshooting

The connection test provides explanations for common HTTP errors:

- **401**: the API key was rejected; replace the saved key.
- **403**: the key lacks permission to use that model.
- **404**: the model ID or endpoint was not found; verify the exact API model
  ID, including any required prefix.
- **429**: a rate limit or account quota was reached.
  - For **NVIDIA NIM free tier**, the extension enforces a **40 RPM hard limit** locally.
    If you hit this, requests will queue and wait for the next available token.
  - For other providers, check your configured `rpmLimit` or provider account limits.
- **5xx**: the provider returned a server error; retry later.

If VS Code says a selected model is unavailable after you edit its ID, start a
new chat and choose that model again from the picker.

### Rate Limiting

The extension includes a built-in token bucket rate limiter:

- **NVIDIA NIM endpoints** (`integrate.api.nvidia.com`, `api.nvidia.com`): **40 RPM hard limit** - automatically enforced, cannot be overridden.
- **Other endpoints**: User-configurable via the `rpmLimit` field in the model configuration. Set to `0` or omit for unlimited.

When a rate limit is reached, requests are queued and automatically retried when tokens become available. This prevents hitting provider-side rate limits and getting 429 errors.

## Build and test

```sh
npm install
npm test
npm run package
```

The VSIX is written to this directory. Never commit API keys or place them in
`model-profiles.json`, source code, or chat messages.

The package's technical extension identifier remains
`local-development.nvidia-chat-model-switcher` so existing installations can
upgrade in place; the user-facing extension name and commands are provider
neutral.
