import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import {
  IntentAssessOptions,
  IntentContext,
  IntentProvider,
  IntentProviderError,
  IntentResult,
} from './intent-provider.interface';
import { extractJsonObject, parseIntentPayload } from './parse-intent-result';
import {
  buildSystemPrompt,
  buildUserPrompt,
  OPENROUTER_JSON_SCHEMA,
} from '../intent-prompt';

interface OpenRouterChatResponse {
  choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
  error?: { message?: string };
}

/**
 * OpenRouter - the fallback provider when Gemini's free tier isn't usable
 * (rate-limited out, key not configured, or erroring). OpenAI-compatible
 * chat-completions shape, routable to any of OpenRouter's free
 * (":free"-suffixed) open-source models via OPENROUTER_MODEL. Defaults to
 * Nemotron 3 Ultra 550B-A55B (55B active params, MoE) - NVIDIA's largest
 * free-tier reasoning model. Picked by live-testing several free
 * candidates against this project's own key: GLM 5.2, GPT-OSS-20B, and
 * Gemma 4 all returned HTTP 429 "temporarily rate-limited upstream" from
 * OpenRouter's shared free pool; the smaller Nemotron 3 Nano (3B active)
 * worked but produced thinner reasoning and a less-calibrated
 * needsDeepReview signal; Ultra worked reliably across repeated calls
 * (no 429) and gave meaningfully better output - correct, more specific
 * taxonomy category selection, richer evidence-grounded factors, and
 * needsDeepReview only firing when genuinely warranted. It runs slower
 * (~40s+ vs Nano's ~13s observed), hence the higher INTELLIGENCE_TIMEOUT_MS
 * default below - this is a real per-call cost, acceptable since
 * assessment already runs async off the queue, not on a user-facing
 * request path. Free-tier availability shifts over time; re-check
 * https://openrouter.ai/api/v1/models (filter `id` ending ":free") and
 * this provider's own live behavior periodically. Requests strict
 * json_schema mode; extractJsonObject still backstops parsing for models
 * (including the current default) that don't formally advertise
 * structured-output support in OpenRouter's model metadata.
 */
@Injectable()
export class OpenRouterIntentProvider implements IntentProvider {
  readonly name = 'openrouter';
  private readonly logger = new Logger(OpenRouterIntentProvider.name);

  constructor(private readonly config: ConfigService) {}

  isConfigured(): boolean {
    return !!this.config.get<string>('OPENROUTER_API_KEY');
  }

  async assess(
    context: IntentContext,
    options?: IntentAssessOptions,
  ): Promise<IntentResult> {
    const apiKey = this.config.get<string>('OPENROUTER_API_KEY');
    if (!apiKey) {
      throw new IntentProviderError(
        this.name,
        'OPENROUTER_API_KEY is not configured',
      );
    }
    const model =
      options?.modelOverride ||
      this.config.get<string>('OPENROUTER_MODEL') ||
      'nvidia/nemotron-3-ultra-550b-a55b:free';
    const timeoutMs = Number(
      this.config.get('INTELLIGENCE_TIMEOUT_MS') || 60_000,
    );
    const userPrompt = options?.userPrompt ?? buildUserPrompt(context);

    try {
      const res = await axios.post<OpenRouterChatResponse>(
        'https://openrouter.ai/api/v1/chat/completions',
        {
          model,
          messages: [
            { role: 'system', content: buildSystemPrompt() },
            { role: 'user', content: userPrompt },
          ],
          response_format: {
            type: 'json_schema',
            json_schema: {
              name: 'intent_assessment',
              strict: true,
              schema: OPENROUTER_JSON_SCHEMA,
            },
          },
          temperature: 0.2,
        },
        {
          timeout: timeoutMs,
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': 'https://github.com/osint-watch',
            'X-Title': 'OSINT Watch Intent Assessment',
          },
        },
      );

      if (res.data.error?.message) {
        throw new Error(res.data.error.message);
      }
      const content = res.data.choices?.[0]?.message?.content;
      if (!content) {
        throw new Error(
          `No content in OpenRouter response (finish_reason=${res.data.choices?.[0]?.finish_reason ?? 'unknown'})`,
        );
      }
      const parsed = parseIntentPayload(extractJsonObject(content));
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
