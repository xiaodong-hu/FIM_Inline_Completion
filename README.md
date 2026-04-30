# FIM Inline Completion

Minimal VS Code extension for Copilot-like ghost-text inline completion.

This is useful for DeepSeek API. It sends:
```jsonc
{
  "model": "deepseek-v4-flash",
  "prompt": "<prefix before cursor>",
  "suffix": "<suffix after cursor>",
  "max_tokens": 64
}
```
to `https://api.deepseek.com/beta/completions`, and inserts `choices[0].text` as an inline completion.

## Build
```bash
npm install
npm run compile
```
And to package a VSIX, run 
```bash
npm run package
```
and install from vscode yourself.

## Configure
Set your key through the command palette `Ctrl+Shift+P` (recommended, it will not store the key in plaintext):
```text
DeepSeek FIM: Set API Key
```

or export it before launching VS Code (discourage)
```bash
export DEEPSEEK_API_KEY="sk-..."
code .
```

Example VS Code settings:
```jsonc
{
  "editor.inlineSuggest.enabled": true,
  "editor.quickSuggestions": {
    "other": "inline",
    "comments": "inline",
    "strings": "inline"
  },
  "editor.quickSuggestionsDelay": 200,

  "FIM.enabled": true,
  "FIM.baseUrl": "https://api.deepseek.com/beta",
  "FIM.completionsPath": "/completions",
  "FIM.model": "deepseek-v4-flash",
  "FIM.maxTokens": 144,
  "FIM.temperature": 0.0,
  "FIM.topP": 0.9,
  "FIM.prefixChars": 1000,
  "FIM.suffixChars": 1000,
  "FIM.debounceMs": 150,
  "FIM.stop": [
      "\n\n",
       "//",
       "\n  "
  ], // stop early to save tokens
  "FIM.withSuffix": true,
  "FIM.logRequests": true // see timing in Output
}
```

Note: please disable other inline providers for best experience
