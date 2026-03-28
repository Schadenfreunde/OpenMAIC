# Fixed Bugs

## BUG-001: Large source material silently truncated to 50,000 characters

**Status**: Fixed

**Severity**: High

**Description**: When a user uploaded a PDF or pasted text exceeding 50,000 characters (`MAX_PDF_CONTENT_CHARS`), the system silently truncated the content with `pdfText.substring(0, MAX_PDF_CONTENT_CHARS)`. This meant that any content beyond the first 50K characters was completely ignored during classroom generation, with no warning or indication to the user that material was being lost.

**Root Cause**: The generation pipeline had a hard character limit with no fallback strategy. Both the streaming flow (`scene-outlines-stream/route.ts`) and async flow (`classroom-generation.ts`) applied the same truncation. The generation preview page showed a brief warning but still discarded the content.

**Fix**: Implemented multi-lesson generation that splits large documents into chunks instead of truncating.

**Changes**:
- Created `lib/generation/text-chunker.ts` — splits text at natural boundaries (markdown headings, paragraphs) into chunks of up to 50K characters each.
- Modified `lib/generation/outline-generator.ts` — accepts `lessonContext` and `orderOffset` to generate outlines per chunk with globally unique order values.
- Modified `lib/server/classroom-generation.ts` — loops over text chunks, generating outlines per lesson with accumulated order offsets.
- Modified `app/api/generate/scene-outlines-stream/route.ts` — same multi-chunk loop for the streaming flow.
- Modified `app/generation-preview/page.tsx` — replaced truncation warning with multi-lesson info message.
- Added `lesson` field to `Scene` and `SceneOutline` types for UI grouping.
- Added `MAX_LESSONS = 12` and `MAX_TOTAL_SCENES = 100` safety constants to prevent runaway API usage.
- Added lesson dividers in the scene sidebar (`components/stage/scene-sidebar.tsx`).
- Added PPTX section headers per lesson in export (`lib/export/use-export-pptx.ts`).

**Safety**: Hard caps ensure the system cannot loop indefinitely — maximum 12 lessons and 100 total scenes. Generation breaks immediately if limits are reached. No retry loops.

---

## BUG-002: Multi-lesson generation stalls indefinitely with Gemini 3 Flash

**Status**: Fixed

**Severity**: Critical

**Description**: When generating 9+ lessons from a large PDF using Gemini 3 Flash, generation would hang indefinitely and never complete. Users saw it freeze after a few outlines, sometimes producing no further output.

**Root Causes**: Three independent issues compounding:
1. **No stream timeout** — The `for await (chunk of textStream)` loop in the SSE outline route had no timeout. If Gemini stalled mid-response, the server hung forever.
2. **Thinking mode enabled for structured output** — Gemini 3 Flash has thinking enabled by default (`defaultEnabled: true, toggleable: false`). This added 30-60 seconds of thinking per lesson before the first token, on top of 15-20s of actual generation. For 9 lessons: ~7-12 minutes just for thinking overhead, with no benefit on JSON output.
3. **Client retry wiped all outlines** — In the SSE client handler, `collected.length = 0` on a retry event cleared ALL previously collected outlines including from completed lessons. A retry for lesson 3 would destroy lesson 1-2's outlines.

**Fix**:
- Added `PER_LESSON_TIMEOUT_MS = 120_000` per-attempt timeout via AbortController in `scene-outlines-stream/route.ts`.
- Passed `{ enabled: false }` thinking config to `streamLLM()` for outline generation.
- Created `aiCallNoThinking` variant in `classroom-generation.ts` for the async flow.
- Added `lessonStartIndex` to SSE retry events so the client truncates only the current lesson's partial outlines on retry, preserving prior lessons.

**Changes**:
- `app/api/generate/scene-outlines-stream/route.ts` — Per-lesson timeout, thinking disabled, retry events include `lessonStartIndex`
- `lib/server/classroom-generation.ts` — `aiCallNoThinking` used for outline generation
- `app/generation-preview/page.tsx` — Retry handler truncates to `lessonStartIndex` instead of clearing all
- `lib/ai/llm.ts` — `abortSignal` parameter added to `streamLLM()`

---

## BUG-003: SSE "Controller is already closed" crash during outline retry

**Status**: Fixed

**Severity**: High

**Description**: When an LLM stream errored and the catch block tried to enqueue a retry event to the SSE `ReadableStream`, it threw `TypeError: Invalid state: Controller is already closed`, crashing the generation.

**Root Cause**: The `cancelled` flag and `abortController` were declared inside the `start()` callback of `new ReadableStream()`, but the `cancel()` callback is a sibling method with no access to them. When the client disconnected, `cancel()` couldn't set `cancelled = true`, so `start()` kept trying to enqueue after the controller was closed.

**Fix**:
- Hoisted `cancelled` and `abortController` to the outer closure before `new ReadableStream()`.
- Added `safeEnqueue()` helper that wraps all `controller.enqueue()` calls in try-catch, setting `cancelled = true` on failure.

**Changes**: `app/api/generate/scene-outlines-stream/route.ts`

---

## BUG-004: All callLLM() calls hang indefinitely on slow/stalled providers

**Status**: Fixed

**Severity**: High

**Description**: Outside of `scene-outlines-stream` (which had a per-lesson timeout), every `callLLM()` invocation (quiz grading, scene content, scene actions, agent profiles, PBL chat) had no timeout. A stalled API provider would block the request indefinitely, holding server resources and giving the user no feedback.

**Root Cause**: The `callLLM()` wrapper passed through to `generateText()` without setting an `AbortSignal`. The AI SDK's internal timeout, if any, was not documented or relied upon.

**Fix**: `callLLM()` now adds `AbortSignal.timeout(60_000)` per attempt when no external signal is provided.

**Changes**: `lib/ai/llm.ts`

---

## BUG-005: Immediate retry on 429 rate-limit errors hammers the API

**Status**: Fixed

**Severity**: Medium

**Description**: When `callLLM()` received a 429 rate-limit error, it retried immediately with no backoff, often triggering another 429 and wasting the retry budget.

**Root Cause**: The retry loop had no error classification — all errors were retried identically with zero delay.

**Fix**: Added 429 detection (checks error message for `429`, `rate limit`, `too many requests`) with exponential backoff: 2s → 4s → 8s, capped at 30s. Non-rate-limit errors still retry immediately.

**Changes**: `lib/ai/llm.ts`

---

## BUG-006: Blind retries send identical prompt after parse failure

**Status**: Fixed

**Severity**: Medium

**Description**: When `callLLM()` retried after a validation failure (empty/invalid JSON response), it resent the exact same prompt. The model had no information about what went wrong, often producing the same invalid output again.

**Fix**: Self-correcting retries — on retry, a hint is prepended to the user prompt: `[Retry note: Your previous response was empty or invalid. Please provide the requested output.]`. For error retries, includes a truncated error message. Only modifies string-based prompts; vision content (array) is left untouched.

**Changes**: `lib/ai/llm.ts` — `buildRetryParams()` helper function

---

## BUG-007: Thinking mode wasting tokens/latency on structured output tasks

**Status**: Fixed

**Severity**: Medium

**Description**: All LLM calls used the global thinking mode (default: enabled). For structured JSON output tasks like quiz grading, action generation, and agent profile creation, thinking mode added 30-60s latency per call with no quality improvement — the output format is fully constrained by the prompt.

**Fix**: Disabled thinking (`{ enabled: false }`) for all structured output tasks: scene-content, scene-actions, quiz-grade, agent-profiles, and pbl-chat. Only outline generation (already fixed in BUG-002) and creative/reasoning tasks in the chat pipeline retain thinking mode.

**Changes**:
- `app/api/generate/scene-content/route.ts`
- `app/api/generate/scene-actions/route.ts`
- `app/api/quiz-grade/route.ts`
- `app/api/generate/agent-profiles/route.ts`
- `app/api/pbl/chat/route.ts`

---

## BUG-008: LangGraph state grows unboundedly in long sessions

**Status**: Fixed

**Severity**: Medium

**Description**: In multi-agent chat sessions, the `agentResponses` and `whiteboardLedger` arrays in the LangGraph director state used append-only reducers with no cap. A 10-turn session with 3 agents accumulated 30 `AgentTurnSummary` objects, all fed into the director prompt on every turn.

**Fix**: Added `.slice(-20)` to `agentResponses` reducer and `.slice(-50)` to `whiteboardLedger` reducer, keeping only the most recent entries.

**Changes**: `lib/orchestration/director-graph.ts`

---

## BUG-009: PBL chat system prompt bloat from large issue descriptions

**Status**: Fixed

**Severity**: Low

**Description**: The PBL chat route concatenated `currentIssue.generated_questions` into the system prompt without a size check. Issues with very large descriptions or question sets could balloon the prompt arbitrarily.

**Fix**: Truncate `issueContext` to 2000 characters with `[... truncated]` suffix before building the system prompt.

**Changes**: `app/api/pbl/chat/route.ts`
