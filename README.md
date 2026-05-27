# FIM Inline Completion

A high-performance VS Code extension for AI-powered inline code completion using the **DeepSeek V4 FIM (Fill-In-the-Middle) API**.

> **Key insight**: By sending the *entire* current file (not a sliding window) plus a *cross-file project preamble*, we achieve **~99% server-side KV-cache hit rates** during continuous typing. This makes completions feel instant after the first keystroke.

## Architecture

### The Sliding-Window Problem (How NOT to do it)

Traditional approaches send a fixed-size window around the cursor:

```mermaid
graph LR
    subgraph "Keystroke N"
        A1["...file content..."] --> W1["[ 12K prefix window ]"]
        W1 --> C1["█ cursor"]
        C1 --> T1["[ 8K suffix window ]"]
        T1 --> B1["...file content..."]
    end

    subgraph "Keystroke N+1 (typed 'x')"
        A2["...file content..."] --> W2["[ 12K prefix window ]"]
        W2 --> C2["x█ cursor"]
        C2 --> T2["[ 8K suffix window ]"]
        T2 --> B2["...file content..."]
    end

    W1 -.->|"EVERY token shifted → 0% KV-cache hit"| W2
```

With a sliding window, **every keystroke shifts all token positions**. The LLM server cannot reuse any previously computed attention states (KV-cache). Every request is a full recomputation.

### The Full-File Solution

Instead, send the **entire file** as prefix + suffix:

```mermaid
graph TB
    subgraph "Keystroke N (cursor at offset 50000)"
        direction LR
        PFX1["prefix = file[0:50000]"]
        SFX1["suffix = file[50000:end]"]
    end

    subgraph "Keystroke N+1 (typed 'x', cursor at offset 50001)"
        direction LR
        PFX2["prefix = file[0:50001]"]
        SFX2["suffix = file[50001:end]"]
    end

    PFX1 -->|"tokens 0-49999: IDENTICAL positions → KV-cache HIT"| PFX2
    SFX1 -->|"tokens shifted by 1 → cache miss (small portion)"| SFX2

    style PFX1 fill:#4f8,stroke:#333
    style PFX2 fill:#4f8,stroke:#333
    style SFX2 fill:#f96,stroke:#333
```

**Result**: ~99.998% of tokens are at identical positions between keystrokes. DeepSeek's server-side **automatic prefix caching** (standard in vLLM/SGLang) reuses the KV-cache for the shared prefix portion, making subsequent requests dramatically faster.

### Multi-File Project Preamble

We go even further by loading **all project source files** (filtered by `.gitignore`) into a **preamble** that is prepended to every FIM request:

```mermaid
graph TB
    subgraph "FIM Prompt Structure"
        direction TB
        P["📦 PREAMBLE (fixed, sorted alphabetically)"]
        F1["### FILE: src/utils.ts ###\ncontent..."]
        F2["### FILE: src/models/user.ts ###\ncontent..."]
        F3["### FILE: lib/helpers.py ###\ncontent..."]
        SEP["═══════════════════════════════"]
        CUR["📝 CURRENT FILE PREFIX\ncontent before cursor"]
        GAP["🟢 [FIM GENERATION GAP]"]
        SUF["📝 CURRENT FILE SUFFIX\ncontent after cursor"]
    end

    P --> F1
    F1 --> F2
    F2 --> F3
    F3 --> SEP
    SEP --> CUR
    CUR --> GAP
    GAP --> SUF

    style P fill:#4af,stroke:#333,color:#fff
    style CUR fill:#4f8,stroke:#333
    style SUF fill:#f96,stroke:#333
    style GAP fill:#ff0,stroke:#333
```

**Why this works**:
- The preamble files are loaded once and **never change positions** between keystrokes → **100% KV-cache hit**
- The current file prefix grows by only 1 character per keystroke → **near-100% KV-cache hit**
- Only the suffix portion shifts → small cache miss, but the suffix is typically much smaller than the prefix
- Files are sorted alphabetically for **deterministic token ordering** across sessions

### Request Flow

```mermaid
sequenceDiagram
    participant User as 👤 User types
    participant VS as VS Code
    participant Ext as FIM Extension
    participant Cache as Local Stream Cache
    participant API as DeepSeek V4 API
    participant KVCache as KV-Cache (server-side)

    User->>VS: keystroke
    VS->>Ext: provideInlineCompletionItems()
    Ext->>Ext: debounce (200ms)
    Ext->>Ext: getFullFilePrefixSuffix()
    Ext->>Ext: getPreamble() [cached 30s]

    alt Local cache hit (nearby offset)
        Ext->>Cache: findNearbyCacheEntry(±16 offsets)
        Cache-->>Ext: buffered tokens from previous stream
        Ext-->>VS: serve from cache (0ms API latency!)
    else Stream in-flight
        Ext->>Cache: wait for in-flight stream
        Cache-->>Ext: partial result
        Ext-->>VS: serve partial
    else Fresh request
        Ext->>API: POST /completions (stream=true)
        Note over API: prompt = preamble + full file prefix
        API->>KVCache: check prefix match
        KVCache-->>API: 99%+ cache hit!
        API-->>Ext: SSE stream (progressive)
        Ext-->>VS: early-return after N tokens
        Ext->>Cache: background: read remaining tokens
    end
```

### Cache Architecture

The extension maintains two complementary caching layers:

| Layer | Location | What it caches | Hit condition |
|-------|----------|---------------|---------------|
| **Local Stream Cache** | Extension memory | Already-streamed completion tokens | Same document ±16 char offset (instant, no API call) |
| **Server-Side KV-Cache** | DeepSeek servers | Computed attention states for all input tokens | Prefix tokens at identical positions (dramatically reduces inference time) |

```mermaid
graph LR
    subgraph "Client Side (VS Code)"
        LC["Local Stream Cache\n(key: docUri | offset | model)"]
    end

    subgraph "Server Side (DeepSeek)"
        KV["KV-Cache\n(automatic prefix caching)"]
    end

    LC -->|"serves buffered tokens\n0ms latency"| User2["👤 User"]
    KV -->|"reuses attention states\nfor shared prefixes"| GPU["🚀 GPU Inference"]

    style LC fill:#ff9,stroke:#333
    style KV fill:#9cf,stroke:#333
```

### Configuration Highlights

| Setting | Default | Purpose |
|---------|---------|---------|
| `FIM.preambleEnabled` | `true` | Enable cross-file project context |
| `FIM.preambleMaxFiles` | `100` | Max other files in preamble |
| `FIM.preambleMaxChars` | `500000` | Soft cap on preamble chars (~125K tokens) |
| `FIM.maxTokens` | `256` | Completion length (max 4096 for FIM Beta) |
| `FIM.streamEnabled` | `true` | Progressive display (show first chunk ASAP) |
| `FIM.streamTokens` | `5` | Tokens to collect before first display |
| `FIM.model` | `deepseek-v4-pro` | Model (1M token context window) |

## Getting Started

### Prerequisites

- VS Code 1.90+
- DeepSeek API key ([get one here](https://platform.deepseek.com/api_keys))

### Installation

1. Install the extension
2. Run `FIM: Set API Key` from the Command Palette (`Ctrl+Shift+P`)
3. Start typing — completions appear automatically

### Manual Setup

```bash
git clone https://github.com/xiaodong-hu/FIM_Inline_Completion
cd FIM_Inline_Completion
npm install
npm run compile
```

Then press `F5` in VS Code to launch the Extension Development Host.

### API Key

Set via the `DEEPSEEK_API_KEY` environment variable, or run `FIM: Set API Key` to store it securely in VS Code's SecretStorage.

## DeepSeek FIM API

This extension uses the [DeepSeek FIM Completion Beta API](https://api-docs.deepseek.com/guides/fim_completion):

- **Endpoint**: `POST https://api.deepseek.com/beta/completions`
- **Model**: `deepseek-v4-pro`
- **Context window**: 1M tokens
- **Max output**: 4K tokens
- **Format**: True Fill-In-the-Middle — both `prompt` (prefix) and `suffix` fields are supported

The prompt sent to the API follows this structure:
```
[### FILE: src/utils.ts ###\n<content>\n### FILE: src/models.ts ###\n<content>\n...]
[<current file content from beginning to cursor>]
```

The suffix sent to the API:
```
[<current file content from cursor to end>]
```

## Performance Notes

### Why Completions Feel Fast

1. **First keystroke**: Full preamble + full file sent (~500K chars / 125K tokens). May take 500-1500ms depending on context size.
2. **Subsequent keystrokes**: DeepSeek's prefix-caching reuses ~99%+ of the computed KV-cache. Latency drops to 100-300ms.
3. **Streaming early-return**: The extension shows the first few tokens as soon as they arrive (typically <200ms), giving an instant-feel response even on the first request.
4. **Local cache**: When typing rapidly, already-streamed tokens from the previous request are served from memory with 0ms latency.

### Memory Usage

- The local stream cache holds at most a few entries (~KB each), evicted after 30s of inactivity.
- The preamble cache holds file contents in memory (~500KB for a typical project), rebuilt every 30s or on file create/delete events.

## License

MIT
