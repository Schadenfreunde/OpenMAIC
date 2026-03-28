/**
 * Cost Tracking Store — Session-level token/cost aggregation
 *
 * Zustand store that accumulates usage records from LLM calls.
 * Session-only (no localStorage persistence). Resets on page reload.
 *
 * This store is part of the isolated cost-tracking feature.
 * It is loaded via require() in cost-tracker.ts. If this file has bugs
 * or is deleted, the app works identically — cost-tracker.ts catches
 * the import failure and falls back to log-only tracking.
 */

import { create } from 'zustand';
import type { UsageRecord } from '@/lib/ai/cost-tracker';

interface UsageBucket {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCostUSD: number;
  callCount: number;
}

export interface CostTrackingState {
  // Aggregated totals
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  totalEstimatedCostUSD: number;
  callCount: number;

  // Per-source breakdown (e.g., 'scene-content', 'quiz-grade', 'pbl-chat')
  bySource: Record<string, UsageBucket>;

  // Per-model breakdown (e.g., 'gemini-3-flash-preview', 'gpt-4o-mini')
  byModel: Record<string, UsageBucket>;

  // Recent records (ring buffer for debugging)
  recentRecords: UsageRecord[];

  // Actions
  addRecord: (record: UsageRecord) => void;
  reset: () => void;
}

const MAX_RECENT_RECORDS = 50;

const EMPTY_BUCKET: UsageBucket = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  estimatedCostUSD: 0,
  callCount: 0,
};

const INITIAL_STATE = {
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalTokens: 0,
  totalEstimatedCostUSD: 0,
  callCount: 0,
  bySource: {} as Record<string, UsageBucket>,
  byModel: {} as Record<string, UsageBucket>,
  recentRecords: [] as UsageRecord[],
};

function addToBucket(bucket: UsageBucket, record: UsageRecord): UsageBucket {
  const cost = record.estimatedCostUSD ?? 0;
  return {
    inputTokens: bucket.inputTokens + record.inputTokens,
    outputTokens: bucket.outputTokens + record.outputTokens,
    totalTokens: bucket.totalTokens + record.totalTokens,
    estimatedCostUSD: bucket.estimatedCostUSD + cost,
    callCount: bucket.callCount + 1,
  };
}

export const useCostTrackingStore = create<CostTrackingState>((set) => ({
  ...INITIAL_STATE,

  addRecord: (record) =>
    set((state) => {
      const cost = record.estimatedCostUSD ?? 0;

      return {
        totalInputTokens: state.totalInputTokens + record.inputTokens,
        totalOutputTokens: state.totalOutputTokens + record.outputTokens,
        totalTokens: state.totalTokens + record.totalTokens,
        totalEstimatedCostUSD: state.totalEstimatedCostUSD + cost,
        callCount: state.callCount + 1,
        bySource: {
          ...state.bySource,
          [record.source]: addToBucket(
            state.bySource[record.source] ?? EMPTY_BUCKET,
            record,
          ),
        },
        byModel: {
          ...state.byModel,
          [record.modelId]: addToBucket(
            state.byModel[record.modelId] ?? EMPTY_BUCKET,
            record,
          ),
        },
        recentRecords: [...state.recentRecords, record].slice(-MAX_RECENT_RECORDS),
      };
    }),

  reset: () => set(INITIAL_STATE),
}));
