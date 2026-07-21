# FIM Inline Completion

A cost-aware VS Code inline-completion extension for DeepSeek's FIM API. Every
network request sends the complete document split at the cursor:

```text
prompt = document[0 .. cursor]
suffix = document[cursor .. end]
```

There is no moving context window and no changing timestamp or metadata before
the document. That gives DeepSeek the longest possible common request prefix
while still providing true fill-in-the-middle context.

## Why this version uses fewer cache-miss tokens

DeepSeek's disk context cache is automatic and prefix-based. A later request can
reuse a persisted prefix unit only when that complete unit matches. Cache
creation is best-effort and can take seconds, so a client should reduce requests
as well as keep their beginnings stable.

This extension uses two layers:

1. **Content-validated local completion cache**
   - An exact prefix + suffix pair immediately reuses its completion.
   - If the user types or accepts the first part of the ghost text, the cached
     remainder is reused only when the old prefix, newly accepted text, and
     entire suffix all match exactly.
   - Cursor proximity and document offsets are never treated as proof of a
     cache hit.
2. **DeepSeek server context cache**
   - A cache-miss request always starts at byte zero of the current document.
   - Normal forward editing preserves the largest possible common prefix.
   - DeepSeek reports hit and miss counts in `prompt_cache_hit_tokens` and
     `prompt_cache_miss_tokens`; enable `FIM.logRequests` to inspect them.

The former project-wide preamble was removed. It added unrelated tokens to
every request and a change near the start of that concatenation could invalidate
the cache for everything after it. Full-document current-file context is stable,
relevant, and easier to reason about.

The DeepSeek dashboard's hit ratio may understate the improvement: a local hit
does not appear as a server cache hit because it sends no request and consumes
no API tokens at all. Compare absolute cache-miss tokens or spend over a similar
editing session, not only the server-side hit percentage.

## Word-by-word acceptance

VS Code can accept part of inline ghost text a word at a time. A naive provider
makes another full FIM request after every accepted word. This extension instead
uses stale-while-revalidate behavior:

```text
accept a word
    -> show the validated cached remainder immediately (no API request)
    -> reset a quiet-period timer
    -> after editing pauses, request one fresh generation
    -> refresh the visible inline suggestion
```

`FIM.revalidateDelayMs` controls the quiet period and defaults to 1500 ms.
Repeated word acceptance keeps postponing the refresh, while a pause allows the
model to change its continuation dynamically.

## Request lifecycle

```text
inline completion requested
    |
    +-- exact local context hit ----------------> return cached completion
    |
    +-- accepted prefix of cached completion ---> return cached remainder
    |                                               schedule one delayed refresh
    |
    +-- genuine context change
            -> debounce
            -> deduplicate identical in-flight request
            -> POST /beta/completions
                 prompt: full prefix
                 suffix: full suffix (always present, including "" at EOF)
            -> show early streamed text
            -> finish stream into local cache
            -> record server cache hit/miss usage
```

Streaming responses are decoded incrementally, including JSON events split
across network chunks. Once an input request has reached DeepSeek, its stream is
allowed to finish in the background even if VS Code cancels the old UI request;
the input has already been billed, and retaining the output often avoids the
next request entirely.

## Installation

```bash
npm install
npm test
npm run package
```

Install the generated VSIX, then run `FIM: Set API Key` from the Command Palette.
Alternatively, set `DEEPSEEK_API_KEY` in the environment that launches VS Code.

## Configuration

| Setting | Default | Purpose |
| --- | ---: | --- |
| `FIM.model` | `deepseek-v4-pro` | Model sent to the FIM endpoint |
| `FIM.maxTokens` | `256` | Maximum generated tokens; DeepSeek FIM allows up to 4096 |
| `FIM.debounceMs` | `250` | Delay for a genuine local-cache miss |
| `FIM.revalidateDelayMs` | `1500` | Quiet period before refreshing a partially accepted completion |
| `FIM.streamEnabled` | `true` | Display early text while the rest streams into cache |
| `FIM.streamTokens` | `5` | Approximate early-display threshold |
| `FIM.localCacheTtlMs` | `300000` | Local completion lifetime |
| `FIM.localCacheMaxEntries` | `64` | Cross-document entry bound |
| `FIM.logRequests` | `false` | Log sizes, latency, and DeepSeek cache usage without source text |

The removed `FIM.withSuffix`, `FIM.streamCacheTtlMs`, and `FIM.preamble*`
settings are ignored when upgrading from 0.2.x. Suffix transmission is now
unconditional because this extension is specifically a FIM provider.

## DeepSeek API behavior

- Endpoint: `POST https://api.deepseek.com/beta/completions`
- Request fields: `prompt` and `suffix`
- Maximum FIM output: 4096 tokens
- Context caching: automatic, prefix-based, best-effort
- Cache telemetry: returned in the response `usage` object

References:

- [DeepSeek FIM Completion guide](https://api-docs.deepseek.com/guides/fim_completion/)
- [DeepSeek FIM API reference](https://api-docs.deepseek.com/api/create-completion/)
- [DeepSeek context caching guide](https://api-docs.deepseek.com/guides/kv_cache/)

## Development

The cost-sensitive logic is kept outside the VS Code adapter and covered by
tests:

- `src/completionCache.ts`: exact and partial-acceptance validation
- `src/fimClient.ts`: request construction, streaming SSE, and usage parsing
- `src/extension.ts`: VS Code lifecycle, debounce, deduplication, and refresh

Run `npm test` before packaging.

## License

MIT
