# FIM Inline Completion

Minimal VS Code extension for Copilot-like ghost-text inline completion.

This is useful for DeepSeek API. It sends:
```jsonc
{
  "model": "deepseek-v4-flash",
  "prompt": "<prefix before cursor>",
  "suffix": "<suffix after cursor>",
  "max_tokens": ...
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
  "FIM.maxTokens": 64,
  "FIM.temperature": 0.0,
  "FIM.topP": 0.9,
  "FIM.prefixChars": 12000,
  "FIM.suffixChars": 8000,
  "FIM.debounceMs": 150,
  "FIM.stop": [], // optional: stop early to save tokens (see note below)
  "FIM.withSuffix": true,
  "FIM.logRequests": true, // see timing in Output

  "FIM.streamEnabled": true,
  "FIM.streamTokens": 12, // how many tokens to wait for before showing the first chunk
  "FIM.streamCacheTtlMs": 30000
}
```

## Streaming (Progressive Completion)

The extension supports **progressive streaming** for a smooth, Copilot-like
typing experience. Instead of waiting for the entire response, completions appear
as soon as a few tokens arrive:

| Setting | Default | Description |
|---|---|---|
| `FIM.streamEnabled` | `true` | Enable progressive streaming. When on, the extension returns after ~`streamTokens` tokens and continues reading the rest in the background. |
| `FIM.streamTokens` | `12` | How many tokens to collect before showing the first chunk. Lower = faster first display, shorter initial suggestion. |
| `FIM.streamCacheTtlMs` | `30000` | How long (in ms) to keep cached stream continuations. On the next keystroke the extension serves the next chunk from cache — **no API call needed**. |

### How it works

```
API stream:  [tok1][tok2][tok3][tok4][tok5]...[tok64]
                   ↑                        ↑
          Return immediately        Continue in background,
          (first chunk shown)       cache for next keystroke
```

1. **Early return** — after ~`streamTokens` tokens arrive (~20 chars), the
   completion is shown immediately (typically <200ms).
2. **Background continuation** — the rest of the SSE stream is read in the
   background and buffered into an in-memory cache.
3. **Cache-first serving** — on the next keystroke, if the context hasn't
   changed meaningfully, the next chunk is served instantly from cache without
   making a new API call. This creates a fluid *token-by-token* rhythm.
4. **Nearby-offset lookup** — the cache searches ±16 character offsets so
   small edits don't invalidate the buffered stream.

To disable streaming and fall back to the original behaviour (wait for the
full response), set `"FIM.streamEnabled": false`.

Note: please disable other inline providers for best experience

> **⚠️ Caution on `FIM.stop`:** Avoid patterns that match common code
> structure. In particular **do not** use `"\\n  "` (newline + two spaces) —
> it matches the start of *every* indented line and will truncate multi-line
> completions. Stick to patterns that are unambiguous end-of-completion
> signals like `"\\n\\n"` (blank line) or comment prefixes. When in doubt,
> leave `FIM.stop` as `[]`.
