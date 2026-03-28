# OpenMAIC Project Guide

## Overview

OpenMAIC (Open Multi-Agent Interactive Classroom) is a Next.js 16 + React 19 + TypeScript platform that generates immersive, multi-agent learning experiences from source materials (PDFs, text). It uses LangGraph for orchestrating AI agents that collaboratively create classroom scenes.

## Architecture

### Two-Stage Generation Pipeline

1. **Stage 1 — Outline Generation**: Takes user requirements + PDF content and produces scene outlines (title, type, description, order).
2. **Stage 2 — Scene Content Generation**: For each outline, generates slide content, interactive elements, quizzes, and speech actions.

### Generation Flows

- **Streaming flow**: SSE via `/api/generate/scene-outlines-stream` route, used by the `generation-preview` page for real-time feedback.
- **Async flow**: Job-based via `/api/generate-classroom`, used by OpenClaw integration.

### Data Model

- **Stage**: One classroom. Contains metadata (name, language, requirements) and scenes.
- **Scene**: A single unit of content (slide, quiz, interactive, PBL). Has a globally unique `order` field per stage.
- **Actions**: Attached to scenes — speech, whiteboard draws, quiz triggers, etc.
- **Lesson**: Optional grouping within a stage. Scenes with `lesson: N` belong to Lesson N. Used when source material is split into chunks.

### Key Stores (Zustand)

- `useStageStore` — stage metadata, scenes, outlines, generation status
- `useCanvasStore` — viewport settings, canvas state
- `useMediaGenerationStore` — media placeholder tracking

## Multi-Lesson Feature

When source material exceeds 50,000 characters, the system automatically splits it into chunks and generates multiple lessons within the same classroom.

### How It Works

1. `chunkText()` in `lib/generation/text-chunker.ts` splits text at natural boundaries (headings, paragraphs).
2. Each chunk becomes a lesson. The outline generator receives lesson context (`[Lesson N of M]`) and an `orderOffset` to maintain globally unique scene orders.
3. Scenes carry a `lesson` field for UI grouping (sidebar dividers, PPTX sections).

### Safety Limits

- `MAX_LESSONS = 5` — Maximum number of text chunks/lessons per classroom.
- `MAX_TOTAL_SCENES = 40` — Hard cap on total scenes across all lessons.
- No retry loops in generation — fail-fast on errors to protect API credits.

### Key Constants

Defined in `lib/constants/generation.ts`:
- `MAX_PDF_CONTENT_CHARS = 50000` — Character limit per chunk.
- `MAX_LESSONS = 12`
- `MAX_TOTAL_SCENES = 100`

## Export System

Entirely client-side using `pptxgenjs` and `file-saver`.

- **PPTX Export**: All slide scenes exported with speaker notes. Multi-lesson classrooms get PPTX sections per lesson.
- **Resource Pack**: ZIP containing PPTX + interactive HTML files.

## Local Setup

Run `bash setup.sh` or `pnpm setup` for automated setup. See README.md for details.

## Key Directories

```
app/                    # Next.js app router pages and API routes
  api/generate/         # Generation endpoints (outlines, content, actions, TTS)
  generation-preview/   # Real-time generation preview page
components/             # React components
  stage/                # Stage playback and sidebar
  slide-renderer/       # Slide rendering engine
lib/
  generation/           # Core generation logic (outline, scene, text-chunker)
  export/               # PPTX export utilities
  store/                # Zustand stores
  types/                # TypeScript type definitions
  i18n/                 # Internationalization (zh-CN, en-US)
  api/                  # IndexedDB stage API layer
  constants/            # App constants
```

---

## AI Performance Notes

An architectural audit was performed (March 2026) across six dimensions. Key findings and current mitigations are documented here. See `fixed_bugs.md` for implementation history.

### Implemented Optimizations

| Area | What Was Done | Files |
|------|--------------|-------|
| **Thinking mode** | Disabled for all structured JSON output tasks (outline, content, actions, quiz-grade, agent-profiles, pbl-chat). Thinking adds 30-60s latency per call with no benefit on format-constrained tasks. | `lib/ai/llm.ts`, all `app/api/generate/*` routes |
| **Default timeout** | `callLLM()` now adds `AbortSignal.timeout(60s)` per attempt when no external signal is provided. Prevents indefinite hangs on slow/stalled providers. | `lib/ai/llm.ts` |
| **Rate-limit backoff** | `callLLM()` detects 429 / "rate limit" errors and applies exponential backoff (2s → 4s → 8s, up to 30s) before retrying. | `lib/ai/llm.ts` |
| **Self-correcting retries** | On retry, `callLLM()` prepends a hint to the user prompt explaining the failure, improving the chance of a valid response. | `lib/ai/llm.ts` |
| **LangGraph state caps** | `agentResponses` capped at 20 entries, `whiteboardLedger` capped at 50 entries to prevent unbounded state growth in long sessions. | `lib/orchestration/director-graph.ts` |
| **PBL context cap** | Issue context truncated to 2000 chars before building the system prompt to prevent bloat from large issue descriptions. | `app/api/pbl/chat/route.ts` |
| **Per-lesson stream timeout** | 120s timeout per attempt in the SSE outline stream. If a lesson stalls mid-token, it aborts and retries (or inserts a placeholder). | `app/api/generate/scene-outlines-stream/route.ts` |

### Known Cost Leaks (Not Yet Fixed)

| Priority | Issue | Where |
|----------|-------|-------|
| CRITICAL | No prompt caching — static system prompts (~2K tokens) re-tokenized every request. For Anthropic: add `cacheControl: { type: 'ephemeral' }` on the system message. | `lib/ai/llm.ts` — `injectProviderOptions()` |
| HIGH | Triple-call-per-scene pattern (outlines → content → actions = 3 API calls). Content and actions share context; fusing them would halve call count. | `app/generation-preview/page.tsx`, `lib/hooks/use-scene-generator.ts` |
| HIGH | No API-level schema enforcement — all JSON output relies on prompt text + 5-tier parse fallback. Use Vercel AI SDK `experimental_output` + Zod schemas where provider supports it. | All generation routes |
| MEDIUM | `allOutlines` array sent to every scene-content and scene-actions call even though only the current outline is needed. | `page.tsx:664,693` |
| MEDIUM | Full conversation history passed to all LangGraph agent nodes without truncation. | `lib/orchestration/director-graph.ts:292` |

### Open Tasks (Phase 3 — Cost Intelligence)

These require dedicated effort and are tracked here for future sprints:

- **Add pricing metadata to model registry** — Extend `ModelInfo` in `lib/types/provider.ts` with `inputCostPer1MTokens` and `outputCostPer1MTokens`. Populate for major models in `lib/ai/providers.ts`.
- **Log token usage** — Capture `result.usage` (inputTokens, outputTokens) in `callLLM()` and log/aggregate per source label.
- **Task-based model routing** — Route quiz-grade, action formatting, and agent-profile generation to cheaper models (e.g., Haiku, Gemini Flash) while keeping generation on the user-selected model.
- **Prompt caching for Anthropic** — Restructure system prompt passing to use the `messages` array format with `cacheControl: { type: 'ephemeral' }` on the system content block. Requires careful testing across all providers.

### Architecture Invariants (Don't Break)

- Dynamic data (user input, PDF content, research context) is always injected at the **END** of prompts, never at the beginning. This ensures the static system prompt prefix is cacheable.
- `callLLM()` is the single entry point for all non-streaming LLM calls. Never call `generateText()` directly from route handlers.
- `streamLLM()` is the single entry point for streaming calls. Always pass an `AbortSignal` to it.
- Thinking is disabled (`{ enabled: false }`) for all structured JSON output tasks. Only enable for creative/reasoning tasks where the model genuinely benefits.
