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
import { buildSystemPrompt, buildUserPrompt } from '../intent-prompt';

interface OpenRouterChatResponse {
  choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
  error?: { message?: string };
}

/**
 * OpenRouter - the fallback provider when Gemini's free tier isn't usable
 * (rate-limited out, key not configured, or erroring). OpenAI-compatible
 * chat-completions shape, routable to any of OpenRouter's free
 * (":free"-suffixed) open-source models via OPENROUTER_MODEL. Free models
 * don't reliably honor response_format, so parsing falls back to
 * extractJsonObject rather than assuming strict JSON.
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
      'meta-llama/llama-3.3-70b-instruct:free';
    const timeoutMs = Number(
      this.config.get('INTELLIGENCE_TIMEOUT_MS') || 30_000,
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
          response_format: { type: 'json_object' },
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
