import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import {
  IntentContext,
  IntentProvider,
  IntentProviderError,
  IntentResult,
} from './intent-provider.interface';
import { extractJsonObject, parseIntentPayload } from './parse-intent-result';
import {
  buildSystemPrompt,
  buildUserPrompt,
  INTENT_JSON_SCHEMA,
} from '../intent-prompt';

interface GeminiGenerateContentResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
  }>;
  promptFeedback?: { blockReason?: string };
}

/**
 * Google Gemini API - the free-tier provider. Uses generationConfig's
 * responseMimeType/responseSchema for structured output (Gemini's native
 * equivalent of tool-forced JSON) rather than free-text parsing.
 */
@Injectable()
export class GeminiIntentProvider implements IntentProvider {
  readonly name = 'gemini';
  private readonly logger = new Logger(GeminiIntentProvider.name);

  constructor(private readonly config: ConfigService) {}

  isConfigured(): boolean {
    return !!this.config.get<string>('GEMINI_API_KEY');
  }

  async assess(context: IntentContext): Promise<IntentResult> {
    const apiKey = this.config.get<string>('GEMINI_API_KEY');
    if (!apiKey) {
      throw new IntentProviderError(
        this.name,
        'GEMINI_API_KEY is not configured',
      );
    }
    const model = this.config.get<string>('GEMINI_MODEL') || 'gemini-3.6-flash';
    const timeoutMs = Number(
      this.config.get('INTELLIGENCE_TIMEOUT_MS') || 30_000,
    );

    try {
      const res = await axios.post<GeminiGenerateContentResponse>(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
          systemInstruction: { parts: [{ text: buildSystemPrompt() }] },
          contents: [
            { role: 'user', parts: [{ text: buildUserPrompt(context) }] },
          ],
          generationConfig: {
            responseMimeType: 'application/json',
            responseSchema: INTENT_JSON_SCHEMA,
            temperature: 0.2,
          },
        },
        {
          params: { key: apiKey },
          timeout: timeoutMs,
          headers: { 'Content-Type': 'application/json' },
        },
      );

      if (res.data.promptFeedback?.blockReason) {
        throw new Error(
          `Blocked by Gemini safety filters: ${res.data.promptFeedback.blockReason}`,
        );
      }
      const text = res.data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) {
        throw new Error(
          `No content in Gemini response (finishReason=${res.data.candidates?.[0]?.finishReason ?? 'unknown'})`,
        );
      }
      const parsed = parseIntentPayload(extractJsonObject(text));
      return { ...parsed, model };
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const status = error.response?.status;
        const body = JSON.stringify(error.response?.data)?.slice(0, 500);
        throw new IntentProviderError(
          this.name,
          `Request failed (HTTP ${status ?? 'network error'}): ${body ?? error.message}`,
          error,
        );
      }
      throw new IntentProviderError(
        this.name,
        error instanceof Error ? error.message : 'Unknown error',
        error,
      );
    }
  }
}
