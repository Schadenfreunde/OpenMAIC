/**
 * Cost Tracker — Observational Token/Cost Tracking
 *
 * This module is completely isolated from the core generation pipeline.
 * It is loaded via require() inside try-catch in llm.ts. If this file
 * has bugs, is deleted, or fails to load, the app works identically.
 *
 * Pricing data lives here (NOT on ModelInfo) to avoid coupling core
 * types to cost-tracking concerns.
 */

import { createLogger } from '@/lib/logger';

const log = createLogger('CostTracker');

// ---------------------------------------------------------------------------
// Pricing Table
// ---------------------------------------------------------------------------

export interface ModelPricing {
  inputPricePer1MTokens: number;
  outputPricePer1MTokens: number;
}

/**
 * Pricing for commonly-used models (USD per 1M tokens).
 * Models not in this table are still tracked (token counts) but get no cost estimate.
 *
 * Last verified: March 2026. Update when pricing changes.
 */
const MODEL_PRICING: Record<string, ModelPricing> = {
  // OpenAI
  'gpt-5.2': { inputPricePer1MTokens: 2.0, outputPricePer1MTokens: 8.0 },
  'gpt-5.1': { inputPricePer1MTokens: 1.5, outputPricePer1MTokens: 6.0 },
  'gpt-5': { inputPricePer1MTokens: 2.0, outputPricePer1MTokens: 8.0 },
  'gpt-5-mini': { inputPricePer1MTokens: 0.4, outputPricePer1MTokens: 1.6 },
  'gpt-4o': { inputPricePer1MTokens: 2.5, outputPricePer1MTokens: 10.0 },
  'gpt-4o-mini': { inputPricePer1MTokens: 0.15, outputPricePer1MTokens: 0.6 },
  'o4-mini': { inputPricePer1MTokens: 1.1, outputPricePer1MTokens: 4.4 },

  // Anthropic
  'claude-opus-4-6': { inputPricePer1MTokens: 15.0, outputPricePer1MTokens: 75.0 },
  'claude-sonnet-4-6': { inputPricePer1MTokens: 3.0, outputPricePer1MTokens: 15.0 },
  'claude-sonnet-4-5': { inputPricePer1MTokens: 3.0, outputPricePer1MTokens: 15.0 },
  'claude-haiku-4-5': { inputPricePer1MTokens: 0.8, outputPricePer1MTokens: 4.0 },

  // Google
  'gemini-3.1-pro-preview': { inputPricePer1MTokens: 1.25, outputPricePer1MTokens: 10.0 },
  'gemini-2.5-pro': { inputPricePer1MTokens: 1.25, outputPricePer1MTokens: 10.0 },
  'gemini-2.5-flash': { inputPricePer1MTokens: 0.15, outputPricePer1MTokens: 0.6 },
  'gemini-3-flash-preview': { inputPricePer1MTokens: 0.15, outputPricePer1MTokens: 0.6 },
};

export function getPricing(modelId: string): ModelPricing | undefined {
  return MODEL_PRICING[modelId];
}

export function estimateCost(
  modelId: string,
  inputTokens: number,
  outputTokens: number,
): number | undefined {
  const pricing = MODEL_PRICING[modelId];
  if (!pricing) return undefined;
  return (
    (inputTokens / 1_000_000) * pricing.inputPricePer1MTokens +
    (outputTokens / 1_000_000) * pricing.outputPricePer1MTokens
  );
}

// ---------------------------------------------------------------------------
// Usage Record
// ---------------------------------------------------------------------------

export interface UsageRecord {
  modelId: string;
  source: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCostUSD: number | undefined;
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Entry Point — called by llm.ts (fire-and-forget, fail-safe)
// ---------------------------------------------------------------------------

/**
 * Track token usage from an LLM call result.
 *
 * Rules:
 * 1. NEVER throws — outer try-catch catches everything
 * 2. NEVER blocks — synchronous, no async/await
 * 3. NEVER modifies LLM results
 */
export function trackUsage(
  modelId: string,
  source: string,
  usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number } | undefined,
): void {
  try {
    if (!usage) return;

    const inputTokens = usage.inputTokens ?? 0;
    const outputTokens = usage.outputTokens ?? 0;
    const totalTokens = usage.totalTokens ?? inputTokens + outputTokens;
    const cost = estimateCost(modelId, inputTokens, outputTokens);

    const record: UsageRecord = {
      modelId,
      source,
      inputTokens,
      outputTokens,
      totalTokens,
      estimatedCostUSD: cost,
      timestamp: Date.now(),
    };

    log.debug(
      `[${source}] ${modelId}: ${inputTokens} in / ${outputTokens} out` +
        (cost !== undefined ? ` (~$${cost.toFixed(4)})` : ''),
    );

    // Push to store — require() so this degrades gracefully if store doesn't exist
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { useCostTrackingStore } = require('@/lib/store/cost-tracking');
      useCostTrackingStore.getState().addRecord(record);
    } catch {
      // Store not available — just log (already logged above via debug)
    }
  } catch (err) {
    // Absolute outer catch — this function NEVER throws
    log.warn('Cost tracking failed (non-fatal):', err);
  }
}
