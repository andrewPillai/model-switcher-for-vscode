# NVIDIA Chat Model Switcher

This VS Code extension adds OpenAI Chat Completions-compatible models to the
Chat model picker. Model definitions are kept in a JSON file; API keys are
prompted separately and stored with VS Code `SecretStorage`, never in that file.

## Configure

1. Install `nvidia-chat-model-switcher-0.1.0.vsix` in VS Code using
   **Extensions → ... → Install from VSIX...**.
2. Run **NVIDIA Chat Models: Open Model Configuration** from the Command
   Palette.
3. The three model IDs you supplied and the NVIDIA NIM endpoint are prefilled.
   Check that each ID exactly matches the NVIDIA model catalog; edit it if the
   catalog shows a provider prefix or a different identifier. The display name
   can be whatever helps you recognize it.
   Leave all three fields blank on the fourth entry until you know that model's
   name, ID, and endpoint; add more entries if needed.
4. Save the file, then run **NVIDIA Chat Models: Apply Model Configuration**.
   Enter an API key for each newly configured model when prompted. Keys are
   stored securely by VS Code and are not written to the JSON file.
5. In Chat, select a model from the model picker. Use the two commands again
   to change model settings or add/remove models.

The `modelId` must be the exact identifier accepted by your endpoint; a friendly
model name is not always the same thing. The endpoint must support streaming
OpenAI Chat Completions, including tool calls if you want to use agent mode.
This extension does not support provider-specific APIs such as Anthropic
Messages unless they also expose a compatible Chat Completions endpoint.

## Build and test

```sh
npm install
npm test
npm run package
```

The resulting VSIX is written to this directory. Do not put API keys in
`model-profiles.json`, source code, or chat messages.
