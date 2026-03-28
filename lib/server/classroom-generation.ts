import { nanoid } from 'nanoid';
import { callLLM } from '@/lib/ai/llm';
import { createStageAPI } from '@/lib/api/stage-api';
import type { StageStore } from '@/lib/api/stage-api-types';
import {
  applyOutlineFallbacks,
  generateSceneOutlinesFromRequirements,
} from '@/lib/generation/outline-generator';
import {
  createSceneWithActions,
  generateSceneActions,
  generateSceneContent,
} from '@/lib/generation/scene-generator';
import { chunkText } from '@/lib/generation/text-chunker';
import { MAX_TOTAL_SCENES, MAX_PARALLEL_LESSONS } from '@/lib/constants/generation';
import type { AICallFn } from '@/lib/generation/pipeline-types';
import type { AgentInfo } from '@/lib/generation/pipeline-types';
import type { SceneOutline } from '@/lib/types/generation';
import { formatTeacherPersonaForPrompt } from '@/lib/generation/prompt-formatters';
import { getDefaultAgents } from '@/lib/orchestration/registry/store';
import { createLogger } from '@/lib/logger';
import { parseModelString } from '@/lib/ai/providers';
import { resolveApiKey, resolveWebSearchApiKey } from '@/lib/server/provider-config';
import { resolveModel } from '@/lib/server/resolve-model';
import { searchWithTavily, formatSearchResultsAsContext } from '@/lib/web-search/tavily';
import { persistClassroom } from '@/lib/server/classroom-storage';
import {
  generateMediaForClassroom,
  replaceMediaPlaceholders,
  generateTTSForClassroom,
} from '@/lib/server/classroom-media-generation';
import type { UserRequirements } from '@/lib/types/generation';
import type { Scene, Stage } from '@/lib/types/stage';

const log = createLogger('Classroom');

export interface GenerateClassroomInput {
  requirement: string;
  pdfContent?: { text: string; images: string[] };
  language?: string;
  enableWebSearch?: boolean;
  enableImageGeneration?: boolean;
  enableVideoGeneration?: boolean;
  enableTTS?: boolean;
  agentMode?: 'default' | 'generate';
}

export type ClassroomGenerationStep =
  | 'initializing'
  | 'researching'
  | 'generating_outlines'
  | 'generating_scenes'
  | 'generating_media'
  | 'generating_tts'
  | 'persisting'
  | 'completed';

export interface ClassroomGenerationProgress {
  step: ClassroomGenerationStep;
  progress: number;
  message: string;
  scenesGenerated: number;
  totalScenes?: number;
}

export interface GenerateClassroomResult {
  id: string;
  url: string;
  stage: Stage;
  scenes: Scene[];
  scenesCount: number;
  createdAt: string;
}

function createInMemoryStore(stage: Stage): StageStore {
  let state = {
    stage: stage as Stage | null,
    scenes: [] as Scene[],
    currentSceneId: null as string | null,
    mode: 'playback' as const,
  };

  const listeners: Array<(s: typeof state, prev: typeof state) => void> = [];

  return {
    getState: () => state,
    setState: (partial: Partial<typeof state>) => {
      const prev = state;
      state = { ...state, ...partial };
      listeners.forEach((fn) => fn(state, prev));
    },
    subscribe: (listener: (s: typeof state, prev: typeof state) => void) => {
      listeners.push(listener);
      return () => {
        const idx = listeners.indexOf(listener);
        if (idx >= 0) listeners.splice(idx, 1);
      };
    },
  };
}

function normalizeLanguage(language?: string): 'zh-CN' | 'en-US' {
  return language === 'en-US' ? 'en-US' : 'zh-CN';
}

function stripCodeFences(text: string): string {
  let cleaned = text.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }
  return cleaned.trim();
}

async function generateAgentProfiles(
  requirement: string,
  language: string,
  aiCall: AICallFn,
): Promise<AgentInfo[]> {
  const systemPrompt =
    'You are an expert instructional designer. Generate agent profiles for a multi-agent classroom simulation. Return ONLY valid JSON, no markdown or explanation.';

  const userPrompt = `Generate agent profiles for a course with this requirement:
${requirement}

Requirements:
- Decide the appropriate number of agents based on the course content (typically 3-5)
- Exactly 1 agent must have role "teacher", the rest can be "assistant" or "student"
- Each agent needs: name, role, persona (2-3 sentences describing personality and teaching/learning style)
- Names and personas must be in language: ${language}

Return a JSON object with this exact structure:
{
  "agents": [
    {
      "name": "string",
      "role": "teacher" | "assistant" | "student",
      "persona": "string (2-3 sentences)"
    }
  ]
}`;

  const response = await aiCall(systemPrompt, userPrompt);
  const rawText = stripCodeFences(response);
  const parsed = JSON.parse(rawText) as {
    agents: Array<{ name: string; role: string; persona: string }>;
  };

  if (!parsed.agents || !Array.isArray(parsed.agents) || parsed.agents.length < 2) {
    throw new Error(`Expected at least 2 agents, got ${parsed.agents?.length ?? 0}`);
  }

  const teacherCount = parsed.agents.filter((a) => a.role === 'teacher').length;
  if (teacherCount !== 1) {
    throw new Error(`Expected exactly 1 teacher, got ${teacherCount}`);
  }

  return parsed.agents.map((a, i) => ({
    id: `gen-server-${i}`,
    name: a.name,
    role: a.role,
    persona: a.persona,
  }));
}

export async function generateClassroom(
  input: GenerateClassroomInput,
  options: {
    baseUrl: string;
    onProgress?: (progress: ClassroomGenerationProgress) => Promise<void> | void;
  },
): Promise<GenerateClassroomResult> {
  const { requirement, pdfContent } = input;

  await options.onProgress?.({
    step: 'initializing',
    progress: 5,
    message: 'Initializing classroom generation',
    scenesGenerated: 0,
  });

  const { model: languageModel, modelInfo, modelString } = resolveModel({});
  log.info(`Using server-configured model: ${modelString}`);

  // Fail fast if the resolved provider has no API key configured
  const { providerId } = parseModelString(modelString);
  const apiKey = resolveApiKey(providerId);
  if (!apiKey) {
    throw new Error(
      `No API key configured for provider "${providerId}". ` +
        `Set the appropriate key in .env.local or server-providers.yml (e.g. ${providerId.toUpperCase()}_API_KEY).`,
    );
  }

  const aiCall: AICallFn = async (systemPrompt, userPrompt, _images) => {
    const result = await callLLM(
      {
        model: languageModel,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        maxOutputTokens: modelInfo?.outputWindow,
      },
      'generate-classroom',
    );
    return result.text;
  };

  // Outline generation uses a variant with thinking disabled (structured JSON output, not reasoning)
  const aiCallNoThinking: AICallFn = async (systemPrompt, userPrompt, _images) => {
    const result = await callLLM(
      {
        model: languageModel,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        maxOutputTokens: modelInfo?.outputWindow,
      },
      'generate-classroom-outlines',
      undefined,
      { enabled: false },
    );
    return result.text;
  };

  const lang = normalizeLanguage(input.language);
  const requirements: UserRequirements = {
    requirement,
    language: lang,
  };
  const pdfText = pdfContent?.text || undefined;

  // Resolve agents based on agentMode
  let agents: AgentInfo[];
  const agentMode = input.agentMode || 'default';
  if (agentMode === 'generate') {
    log.info('Generating custom agent profiles via LLM...');
    try {
      agents = await generateAgentProfiles(requirement, lang, aiCall);
      log.info(`Generated ${agents.length} agent profiles`);
    } catch (e) {
      log.warn('Agent profile generation failed, falling back to defaults:', e);
      agents = getDefaultAgents();
    }
  } else {
    agents = getDefaultAgents();
  }
  const teacherContext = formatTeacherPersonaForPrompt(agents);

  await options.onProgress?.({
    step: 'researching',
    progress: 10,
    message: 'Researching topic',
    scenesGenerated: 0,
  });

  // Web search (optional, graceful degradation)
  let researchContext: string | undefined;
  if (input.enableWebSearch) {
    const tavilyKey = resolveWebSearchApiKey();
    if (tavilyKey) {
      try {
        log.info('Running web search for requirement context...');
        const searchResult = await searchWithTavily({ query: requirement, apiKey: tavilyKey });
        researchContext = formatSearchResultsAsContext(searchResult);
        if (researchContext) {
          log.info(`Web search returned ${searchResult.sources.length} sources`);
        }
      } catch (e) {
        log.warn('Web search failed, continuing without search context:', e);
      }
    } else {
      log.warn('enableWebSearch is true but no Tavily API key configured, skipping web search');
    }
  }

  await options.onProgress?.({
    step: 'generating_outlines',
    progress: 15,
    message: 'Generating scene outlines',
    scenesGenerated: 0,
  });

  // Split large documents into chunks for multi-lesson generation
  const chunks = pdfText ? chunkText(pdfText) : [{ text: pdfText, partNumber: 1, totalParts: 1 }];
  const isMultiLesson = chunks.length > 1;
  if (isMultiLesson) {
    log.info(`Document split into ${chunks.length} lessons (${pdfText!.length} chars total)`);
  }

  // Generate outlines for a single chunk (with one retry on failure)
  async function generateLessonOutlines(chunk: typeof chunks[number]): Promise<{
    partNumber: number;
    outlines: SceneOutline[];
    failed: boolean;
  }> {
    const lessonContext = isMultiLesson
      ? { partNumber: chunk.partNumber, totalParts: chunk.totalParts }
      : undefined;

    for (let attempt = 1; attempt <= 2; attempt++) {
      const outlinesResult = await generateSceneOutlinesFromRequirements(
        requirements,
        chunk.text || undefined,
        undefined,
        aiCallNoThinking,
        undefined,
        {
          imageGenerationEnabled: input.enableImageGeneration,
          videoGenerationEnabled: input.enableVideoGeneration,
          researchContext,
          teacherContext,
          lessonContext,
          orderOffset: 0, // temporary, renumbered after all lessons complete
        },
      );

      if (outlinesResult.success && outlinesResult.data && outlinesResult.data.length > 0) {
        return { partNumber: chunk.partNumber, outlines: outlinesResult.data, failed: false };
      }

      if (attempt === 1) {
        log.warn(`Lesson ${chunk.partNumber} outline generation failed (attempt 1), retrying...`);
      } else {
        log.error(`Lesson ${chunk.partNumber} outline generation failed after retry: ${outlinesResult.error}`);
      }
    }

    // Both attempts failed — return placeholder
    return {
      partNumber: chunk.partNumber,
      outlines: [{
        id: nanoid(),
        type: 'slide' as const,
        title: lang === 'zh-CN'
          ? `第 ${chunk.partNumber} 课 — 生成失败`
          : `Lesson ${chunk.partNumber} — Generation Failed`,
        description: lang === 'zh-CN'
          ? '此课程的内容生成失败，请重试。'
          : 'Content generation failed for this lesson. Please retry.',
        keyPoints: [],
        order: 0,
        lesson: chunk.partNumber,
      }],
      failed: true,
    };
  }

  // Generate outlines in parallel (batches of MAX_PARALLEL_LESSONS)
  const lessonResults: Awaited<ReturnType<typeof generateLessonOutlines>>[] = [];
  for (let batchStart = 0; batchStart < chunks.length; batchStart += MAX_PARALLEL_LESSONS) {
    const batch = chunks.slice(batchStart, batchStart + MAX_PARALLEL_LESSONS);
    const batchResults = await Promise.all(batch.map(generateLessonOutlines));
    lessonResults.push(...batchResults);

    await options.onProgress?.({
      step: 'generating_outlines',
      progress: 15 + Math.floor(((batchStart + batch.length) / chunks.length) * 15),
      message: isMultiLesson
        ? `Generated outlines for ${Math.min(batchStart + batch.length, chunks.length)} of ${chunks.length} lessons`
        : 'Generating scene outlines',
      scenesGenerated: 0,
    });
  }

  // Sort by lesson order and renumber with globally unique orders
  lessonResults.sort((a, b) => a.partNumber - b.partNumber);
  const allOutlines: SceneOutline[] = [];
  let orderCounter = 0;
  for (const result of lessonResults) {
    for (const outline of result.outlines) {
      orderCounter++;
      outline.order = orderCounter;
      if (isMultiLesson) {
        outline.lesson = result.partNumber;
      }
    }
    allOutlines.push(...result.outlines);
  }

  // Trim to MAX_TOTAL_SCENES if needed
  const outlines = allOutlines.slice(0, MAX_TOTAL_SCENES);
  if (allOutlines.length > MAX_TOTAL_SCENES) {
    log.warn(`Trimmed outlines from ${allOutlines.length} to ${MAX_TOTAL_SCENES}`);
  }
  const failedLessons = lessonResults.filter((r) => r.failed).map((r) => r.partNumber);
  if (failedLessons.length > 0) {
    log.warn(`Lessons with placeholder (generation failed): ${failedLessons.join(', ')}`);
  }
  log.info(`Generated ${outlines.length} total scene outlines${isMultiLesson ? ` across ${chunks.length} lessons` : ''}`);

  await options.onProgress?.({
    step: 'generating_outlines',
    progress: 30,
    message: `Generated ${outlines.length} scene outlines`,
    scenesGenerated: 0,
    totalScenes: outlines.length,
  });

  const stageId = nanoid(10);
  const stage: Stage = {
    id: stageId,
    name: outlines[0]?.title || requirement.slice(0, 50),
    description: undefined,
    language: lang,
    style: 'interactive',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  const store = createInMemoryStore(stage);
  const api = createStageAPI(store);

  log.info('Stage 2: Generating scene content and actions...');
  let generatedScenes = 0;

  // Generate scenes in parallel batches
  for (let batchStart = 0; batchStart < outlines.length; batchStart += MAX_PARALLEL_LESSONS) {
    const batch = outlines.slice(batchStart, batchStart + MAX_PARALLEL_LESSONS);

    await options.onProgress?.({
      step: 'generating_scenes',
      progress: Math.max(30 + Math.floor((batchStart / Math.max(outlines.length, 1)) * 60), 31),
      message: `Generating scenes ${batchStart + 1}-${batchStart + batch.length} of ${outlines.length}`,
      scenesGenerated: generatedScenes,
      totalScenes: outlines.length,
    });

    const batchResults = await Promise.all(
      batch.map(async (outline) => {
        const safeOutline = applyOutlineFallbacks(outline, true);
        const content = await generateSceneContent(
          safeOutline,
          aiCall,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          agents,
        );
        if (!content) {
          log.warn(`Skipping scene "${safeOutline.title}" — content generation failed`);
          return null;
        }

        const actions = await generateSceneActions(safeOutline, content, aiCall, undefined, agents);
        log.info(`Scene "${safeOutline.title}": ${actions.length} actions`);
        return { outline: safeOutline, content, actions };
      }),
    );

    // Create scenes in order (store mutation is fast and synchronous)
    for (const result of batchResults) {
      if (!result) continue;
      const sceneId = createSceneWithActions(result.outline, result.content, result.actions, api);
      if (sceneId) {
        generatedScenes += 1;
      } else {
        log.warn(`Skipping scene "${result.outline.title}" — scene creation failed`);
      }
    }

    await options.onProgress?.({
      step: 'generating_scenes',
      progress: Math.min(30 + Math.floor(((batchStart + batch.length) / Math.max(outlines.length, 1)) * 60), 90),
      message: `Generated ${generatedScenes}/${outlines.length} scenes`,
      scenesGenerated: generatedScenes,
      totalScenes: outlines.length,
    });
  }

  const scenes = store.getState().scenes;
  log.info(`Pipeline complete: ${scenes.length} scenes generated`);

  if (scenes.length === 0) {
    throw new Error('No scenes were generated');
  }

  // Phase: Media generation (after all scenes generated)
  if (input.enableImageGeneration || input.enableVideoGeneration) {
    await options.onProgress?.({
      step: 'generating_media',
      progress: 90,
      message: 'Generating media files',
      scenesGenerated: scenes.length,
      totalScenes: outlines.length,
    });

    try {
      const mediaMap = await generateMediaForClassroom(outlines, stageId, options.baseUrl);
      replaceMediaPlaceholders(scenes, mediaMap);
      log.info(`Media generation complete: ${Object.keys(mediaMap).length} files`);
    } catch (err) {
      log.warn('Media generation phase failed, continuing:', err);
    }
  }

  // Phase: TTS generation
  if (input.enableTTS) {
    await options.onProgress?.({
      step: 'generating_tts',
      progress: 94,
      message: 'Generating TTS audio',
      scenesGenerated: scenes.length,
      totalScenes: outlines.length,
    });

    try {
      await generateTTSForClassroom(scenes, stageId, options.baseUrl);
      log.info('TTS generation complete');
    } catch (err) {
      log.warn('TTS generation phase failed, continuing:', err);
    }
  }

  await options.onProgress?.({
    step: 'persisting',
    progress: 98,
    message: 'Persisting classroom data',
    scenesGenerated: scenes.length,
    totalScenes: outlines.length,
  });

  const persisted = await persistClassroom(
    {
      id: stageId,
      stage,
      scenes,
    },
    options.baseUrl,
  );

  log.info(`Classroom persisted: ${persisted.id}, URL: ${persisted.url}`);

  await options.onProgress?.({
    step: 'completed',
    progress: 100,
    message: 'Classroom generation completed',
    scenesGenerated: scenes.length,
    totalScenes: outlines.length,
  });

  return {
    id: persisted.id,
    url: persisted.url,
    stage,
    scenes,
    scenesCount: scenes.length,
    createdAt: persisted.createdAt,
  };
}
