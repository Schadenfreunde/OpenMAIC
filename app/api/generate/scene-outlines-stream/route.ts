/**
 * Scene Outlines Streaming API (SSE)
 *
 * Streams outline generation via Server-Sent Events.
 * Emits individual outline objects as they're parsed from the LLM response,
 * so the frontend can display them incrementally.
 *
 * SSE events:
 *   { type: 'outline', data: SceneOutline, index: number }
 *   { type: 'done', outlines: SceneOutline[] }
 *   { type: 'error', error: string }
 */

import { NextRequest } from 'next/server';
import { streamLLM } from '@/lib/ai/llm';
import { buildPrompt, PROMPT_IDS } from '@/lib/generation/prompts';
import {
  formatImageDescription,
  formatImagePlaceholder,
  buildVisionUserContent,
  uniquifyMediaElementIds,
  formatTeacherPersonaForPrompt,
} from '@/lib/generation/generation-pipeline';
import type { AgentInfo } from '@/lib/generation/generation-pipeline';
import { MAX_PDF_CONTENT_CHARS, MAX_VISION_IMAGES, MAX_TOTAL_SCENES } from '@/lib/constants/generation';
import { chunkText } from '@/lib/generation/text-chunker';
import { nanoid } from 'nanoid';
import type {
  UserRequirements,
  PdfImage,
  SceneOutline,
  ImageMapping,
} from '@/lib/types/generation';
import { apiError } from '@/lib/server/api-response';
import { createLogger } from '@/lib/logger';
import { resolveModelFromHeaders } from '@/lib/server/resolve-model';
const log = createLogger('Outlines Stream');

export const maxDuration = 600;

/**
 * Incremental JSON array parser.
 * Extracts complete top-level objects from a partially-streamed JSON array.
 * Returns newly found objects (skipping `alreadyParsed` count).
 */
function extractNewOutlines(buffer: string, alreadyParsed: number): SceneOutline[] {
  const results: SceneOutline[] = [];

  // Find the start of the JSON array (skip any markdown fencing)
  const stripped = buffer.replace(/^[\s\S]*?(?=\[)/, '');
  const arrayStart = stripped.indexOf('[');
  if (arrayStart === -1) return results;

  let depth = 0;
  let objectStart = -1;
  let inString = false;
  let escaped = false;
  let objectCount = 0;

  for (let i = arrayStart + 1; i < stripped.length; i++) {
    const char = stripped[i];

    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\' && inString) {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (char === '{') {
      if (depth === 0) objectStart = i;
      depth++;
    } else if (char === '}') {
      depth--;
      if (depth === 0 && objectStart >= 0) {
        objectCount++;
        if (objectCount > alreadyParsed) {
          try {
            const obj = JSON.parse(stripped.substring(objectStart, i + 1));
            results.push(obj);
          } catch {
            // Incomplete or invalid JSON — skip
          }
        }
        objectStart = -1;
      }
    }
  }

  return results;
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();

    // Get API configuration from request headers
    const { model: languageModel, modelInfo, modelString } = resolveModelFromHeaders(req);

    if (!body.requirements) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'Requirements are required');
    }

    const { requirements, pdfText, pdfImages, imageMapping, researchContext, agents } = body as {
      requirements: UserRequirements;
      pdfText?: string;
      pdfImages?: PdfImage[];
      imageMapping?: ImageMapping;
      researchContext?: string;
      agents?: AgentInfo[];
    };

    // Detect vision capability
    const hasVision = !!modelInfo?.capabilities?.vision;

    // Build prompt (same logic as generateSceneOutlinesFromRequirements)
    let availableImagesText =
      requirements.language === 'zh-CN' ? '无可用图片' : 'No images available';
    let visionImages: Array<{ id: string; src: string }> | undefined;

    if (pdfImages && pdfImages.length > 0) {
      if (hasVision && imageMapping) {
        // Vision mode: split into vision images (first N) and text-only (rest)
        const allWithSrc = pdfImages.filter((img) => imageMapping[img.id]);
        const visionSlice = allWithSrc.slice(0, MAX_VISION_IMAGES);
        const textOnlySlice = allWithSrc.slice(MAX_VISION_IMAGES);
        const noSrcImages = pdfImages.filter((img) => !imageMapping[img.id]);

        const visionDescriptions = visionSlice.map((img) =>
          formatImagePlaceholder(img, requirements.language),
        );
        const textDescriptions = [...textOnlySlice, ...noSrcImages].map((img) =>
          formatImageDescription(img, requirements.language),
        );
        availableImagesText = [...visionDescriptions, ...textDescriptions].join('\n');

        visionImages = visionSlice.map((img) => ({
          id: img.id,
          src: imageMapping[img.id],
          width: img.width,
          height: img.height,
        }));
      } else {
        // Text-only mode: full descriptions
        availableImagesText = pdfImages
          .map((img) => formatImageDescription(img, requirements.language))
          .join('\n');
      }
    }

    // Build media generation policy based on enabled flags
    const imageGenerationEnabled = req.headers.get('x-image-generation-enabled') === 'true';
    const videoGenerationEnabled = req.headers.get('x-video-generation-enabled') === 'true';
    let mediaGenerationPolicy = '';
    if (!imageGenerationEnabled && !videoGenerationEnabled) {
      mediaGenerationPolicy =
        '**IMPORTANT: Do NOT include any mediaGenerations in the outlines. Both image and video generation are disabled.**';
    } else if (!imageGenerationEnabled) {
      mediaGenerationPolicy =
        '**IMPORTANT: Do NOT include any image mediaGenerations (type: "image") in the outlines. Image generation is disabled. Video generation is allowed.**';
    } else if (!videoGenerationEnabled) {
      mediaGenerationPolicy =
        '**IMPORTANT: Do NOT include any video mediaGenerations (type: "video") in the outlines. Video generation is disabled. Image generation is allowed.**';
    }

    // Build teacher context from agents (if available)
    const teacherContext = formatTeacherPersonaForPrompt(agents);

    // Split large documents into chunks for multi-lesson generation
    const chunks = pdfText ? chunkText(pdfText) : [{ text: pdfText, partNumber: 1, totalParts: 1 }];
    const isMultiLesson = chunks.length > 1;

    log.info(
      `Generating outlines: "${requirements.requirement.substring(0, 50)}" [model=${modelString}]${isMultiLesson ? ` (${chunks.length} lessons)` : ''}`,
    );

    // Create SSE stream with heartbeat to prevent connection timeout
    const encoder = new TextEncoder();
    const HEARTBEAT_INTERVAL_MS = 15_000;
    let cancelled = false;
    const abortController = new AbortController();

    // Cap research context when PDF content is large to avoid overwhelming the LLM
    const cappedResearchContext =
      pdfText && pdfText.length > 10000
        ? (researchContext || '').substring(0, 2000)
        : researchContext;

    const stream = new ReadableStream({
      async start(controller) {

        // Safe enqueue: swallows errors if controller is already closed/cancelled
        const safeEnqueue = (data: Uint8Array): boolean => {
          if (cancelled) return false;
          try {
            controller.enqueue(data);
            return true;
          } catch {
            cancelled = true;
            return false;
          }
        };

        // Heartbeat: periodically send SSE comments to keep the connection alive.
        let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
        const startHeartbeat = () => {
          stopHeartbeat();
          heartbeatTimer = setInterval(() => {
            safeEnqueue(encoder.encode(`:heartbeat\n\n`));
            if (cancelled) stopHeartbeat();
          }, HEARTBEAT_INTERVAL_MS);
        };
        const stopHeartbeat = () => {
          if (heartbeatTimer) {
            clearInterval(heartbeatTimer);
            heartbeatTimer = null;
          }
        };

        const MAX_STREAM_RETRIES = 2;
        const PER_LESSON_TIMEOUT_MS = 120_000; // 2 minutes per attempt

        try {
          startHeartbeat();

          // Send lesson info if multi-lesson
          if (isMultiLesson) {
            const lessonInfoEvent = JSON.stringify({
              type: 'lesson-info',
              totalLessons: chunks.length,
            });
            safeEnqueue(encoder.encode(`data: ${lessonInfoEvent}\n\n`));
          }

          let allParsedOutlines: SceneOutline[] = [];
          let lastError: string | undefined;

          for (const textChunk of chunks) {
            if (cancelled) break;
            // Build lesson-specific requirement
            let effectiveRequirement = requirements.requirement;
            if (isMultiLesson) {
              const prefix =
                requirements.language === 'zh-CN'
                  ? `[第 ${textChunk.partNumber} 课，共 ${textChunk.totalParts} 课 — 仅涵盖以下部分的内容] `
                  : `[Lesson ${textChunk.partNumber} of ${textChunk.totalParts} — covering only this section of the source material] `;
              effectiveRequirement = prefix + effectiveRequirement;
            }

            const chunkPdfContent = textChunk.text
              ? textChunk.text.substring(0, MAX_PDF_CONTENT_CHARS)
              : requirements.language === 'zh-CN'
                ? '无'
                : 'None';

            const prompts = buildPrompt(PROMPT_IDS.REQUIREMENTS_TO_OUTLINES, {
              requirement: effectiveRequirement,
              language: requirements.language,
              pdfContent: chunkPdfContent,
              availableImages: availableImagesText,
              researchContext: cappedResearchContext || (requirements.language === 'zh-CN' ? '无' : 'None'),
              mediaGenerationPolicy,
              teacherContext,
            });

            if (!prompts) {
              const errorEvent = JSON.stringify({
                type: 'error',
                error: 'Prompt template not found',
              });
              safeEnqueue(encoder.encode(`data: ${errorEvent}\n\n`));
              break;
            }

            const streamParams = visionImages?.length
              ? {
                  model: languageModel,
                  system: prompts.system,
                  messages: [
                    {
                      role: 'user' as const,
                      content: buildVisionUserContent(prompts.user, visionImages),
                    },
                  ],
                  maxOutputTokens: modelInfo?.outputWindow,
                }
              : {
                  model: languageModel,
                  system: prompts.system,
                  prompt: prompts.user,
                  maxOutputTokens: modelInfo?.outputWindow,
                };

            let parsedOutlines: SceneOutline[] = [];

            for (let attempt = 1; attempt <= MAX_STREAM_RETRIES + 1; attempt++) {
              try {
                // Per-attempt timeout: abort if LLM stalls
                const attemptAbort = new AbortController();
                const timeoutId = setTimeout(() => attemptAbort.abort(), PER_LESSON_TIMEOUT_MS);
                // Combine with global abort (client disconnect)
                const onGlobalAbort = () => attemptAbort.abort();
                abortController.signal.addEventListener('abort', onGlobalAbort, { once: true });

                const result = streamLLM(
                  streamParams,
                  'scene-outlines-stream',
                  { enabled: false }, // Disable thinking — outline generation is structured output, not reasoning
                  attemptAbort.signal,
                );

                let fullText = '';
                parsedOutlines = [];
                const orderOffset = allParsedOutlines.length;

                try {
                for await (const chunk of result.textStream) {
                  if (cancelled) break;
                  fullText += chunk;

                  // Try to extract new outlines from the accumulated text
                  const newOutlines = extractNewOutlines(fullText, parsedOutlines.length);
                  for (const outline of newOutlines) {
                    // Ensure ID, order (globally unique), and lesson
                    const enriched = {
                      ...outline,
                      id: outline.id || nanoid(),
                      order: orderOffset + parsedOutlines.length + 1,
                      ...(isMultiLesson ? { lesson: textChunk.partNumber } : {}),
                    };
                    parsedOutlines.push(enriched);

                    const event = JSON.stringify({
                      type: 'outline',
                      data: enriched,
                      index: allParsedOutlines.length + parsedOutlines.length - 1,
                    });
                    safeEnqueue(encoder.encode(`data: ${event}\n\n`));
                  }
                }
                } finally {
                  clearTimeout(timeoutId);
                  abortController.signal.removeEventListener('abort', onGlobalAbort);
                }

                // Validate: got outlines?
                if (parsedOutlines.length > 0) break;

                // Empty result — retry if we have attempts left
                lastError = fullText.trim()
                  ? 'LLM response could not be parsed into outlines'
                  : 'LLM returned empty response';

                if (attempt <= MAX_STREAM_RETRIES) {
                  log.warn(
                    `Empty outlines (attempt ${attempt}/${MAX_STREAM_RETRIES + 1}), retrying...`,
                  );
                  const retryEvent = JSON.stringify({
                    type: 'retry',
                    attempt,
                    maxAttempts: MAX_STREAM_RETRIES + 1,
                    lessonStartIndex: allParsedOutlines.length,
                  });
                  safeEnqueue(encoder.encode(`data: ${retryEvent}\n\n`));
                  if (cancelled) break;
                }
              } catch (error) {
                lastError = error instanceof Error ? error.message : String(error);

                if (attempt <= MAX_STREAM_RETRIES) {
                  log.warn(
                    `Stream error (attempt ${attempt}/${MAX_STREAM_RETRIES + 1}), retrying...`,
                    error,
                  );
                  const retryEvent = JSON.stringify({
                    type: 'retry',
                    attempt,
                    maxAttempts: MAX_STREAM_RETRIES + 1,
                    lessonStartIndex: allParsedOutlines.length,
                  });
                  if (!safeEnqueue(encoder.encode(`data: ${retryEvent}\n\n`))) break;
                  continue;
                }
              }
            }

            // If all retries exhausted with no outlines, insert a placeholder
            if (parsedOutlines.length === 0 && isMultiLesson) {
              log.warn(`Lesson ${textChunk.partNumber}: all retries exhausted, inserting placeholder`);
              const placeholder: SceneOutline = {
                id: nanoid(),
                type: 'slide',
                title: requirements.language === 'zh-CN'
                  ? `第 ${textChunk.partNumber} 课 — 生成失败`
                  : `Lesson ${textChunk.partNumber} — Generation Failed`,
                description: requirements.language === 'zh-CN'
                  ? '此课程的内容生成失败，请重试。'
                  : 'Content generation failed for this lesson. Please retry.',
                keyPoints: [],
                order: allParsedOutlines.length + 1,
                lesson: textChunk.partNumber,
              };
              parsedOutlines.push(placeholder);
              const placeholderEvent = JSON.stringify({
                type: 'outline',
                data: placeholder,
                index: allParsedOutlines.length,
              });
              safeEnqueue(encoder.encode(`data: ${placeholderEvent}\n\n`));
            }

            allParsedOutlines.push(...parsedOutlines);

            // Safety: stop if we've hit the scene cap
            if (allParsedOutlines.length >= MAX_TOTAL_SCENES) {
              log.warn(`Hit MAX_TOTAL_SCENES (${MAX_TOTAL_SCENES}), stopping at lesson ${textChunk.partNumber}`);
              break;
            }
          }

          // Trim to MAX_TOTAL_SCENES
          const finalOutlines = allParsedOutlines.slice(0, MAX_TOTAL_SCENES);

          if (finalOutlines.length > 0) {
            // Replace sequential gen_img_N/gen_vid_N with globally unique IDs
            const uniquifiedOutlines = uniquifyMediaElementIds(finalOutlines);
            // Send done event with all outlines
            const doneEvent = JSON.stringify({
              type: 'done',
              outlines: uniquifiedOutlines,
            });
            safeEnqueue(encoder.encode(`data: ${doneEvent}\n\n`));
          } else {
            // All retries exhausted, no outlines produced
            log.error(
              `Outline generation failed after all attempts: ${lastError}`,
            );
            const errorEvent = JSON.stringify({
              type: 'error',
              error: lastError || 'Failed to generate outlines',
            });
            safeEnqueue(encoder.encode(`data: ${errorEvent}\n\n`));
          }
        } catch (error) {
          const errorEvent = JSON.stringify({
            type: 'error',
            error: error instanceof Error ? error.message : String(error),
          });
          safeEnqueue(encoder.encode(`data: ${errorEvent}\n\n`));
        } finally {
          stopHeartbeat();
          if (!cancelled) {
            try { controller.close(); } catch { /* already closed */ }
          }
        }
      },
      cancel() {
        // Client disconnected — stop LLM calls and processing
        cancelled = true;
        try { abortController.abort(); } catch { /* already aborted */ }
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    });
  } catch (error) {
    log.error('Streaming error:', error);
    return apiError('INTERNAL_ERROR', 500, error instanceof Error ? error.message : String(error));
  }
}
