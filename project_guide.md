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
- `MAX_LESSONS = 5`
- `MAX_TOTAL_SCENES = 40`

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
