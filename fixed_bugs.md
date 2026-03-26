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
