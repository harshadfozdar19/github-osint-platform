import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';

/**
 * `active` = the credential authenticated successfully against its own
 * provider right now - the strongest possible signal that this is a live,
 * exploitable leak.
 * `invalid` = the provider explicitly rejected it (expired/revoked/typo'd).
 * `unsupported` = there's no safe, read-only, provider-sanctioned way to
 * check this credential type (see per-case comments below for why).
 * `error` = the check itself failed (network/timeout) - inconclusive, not
 * a verdict either way.
 */
export type VerificationStatus = 'active' | 'invalid' | 'unsupported' | 'error';

export interface VerificationResult {
  status: VerificationStatus;
  detail: string;
  checkedAt: Date;
}

const TIMEOUT_MS = 8000;

function unsupported(detail: string): VerificationResult {
  return { status: 'unsupported', detail, checkedAt: new Date() };
}

/**
 * Makes exactly one, read-only, provider-official "who am I" call per
 * supported credential type (GitHub `/user`, Stripe `/v1/balance`, Slack
 * `auth.test`, etc.) - the same class of check GitHub's own secret scanning
 * and tools like TruffleHog perform. Deliberately does NOT attempt to
 * verify credentials that would require an actually riskier action:
 * - DB connection strings (Mongo/Redis/Postgres/MySQL): verifying would mean
 *   opening a live connection to an arbitrary third-party database server,
 *   not calling a sanctioned auth-check endpoint - a materially different
 *   and more invasive action than the HTTPS checks below.
 * - AWS access keys / Twilio API keys: these are one half of a keypair:
 *   AWS needs the paired secret key to SigV4-sign a request; Twilio API
 *   Keys need a paired secret. Neither is reliably recoverable from the
 *   same match, so there is no safe way to verify the bare value alone.
 * - Firebase/GCP service-account JSON, generic tokens, JWTs, certificates,
 *   SSH private keys: no fixed provider endpoint to check against (a JWT or
 *   "bearer token" could belong to any service; a private key's validity
 *   can only be checked against a specific unknown host).
 */
@Injectable()
export class CredentialVerificationService {
  private readonly logger = new Logger(CredentialVerificationService.name);

  async verify(ruleId: string, rawValue: string): Promise<VerificationResult> {
    try {
      switch (ruleId) {
        case 'secret-github-pat':
          return await this.verifyGitHub(rawValue);
        case 'secret-stripe-live':
          return await this.verifyStripe(rawValue);
        case 'secret-slack-token':
          return await this.verifySlack(rawValue);
        case 'secret-anthropic-key':
          return await this.verifyAnthropic(rawValue);
        case 'secret-openai-key':
          return await this.verifyOpenAI(rawValue);
        case 'secret-discord-bot':
          return await this.verifyDiscordBot(rawValue);
        case 'secret-discord-webhook':
          return await this.verifyDiscordWebhook(rawValue);
        case 'secret-telegram-token':
          return await this.verifyTelegram(rawValue);
        case 'secret-sendgrid':
          return await this.verifySendGrid(rawValue);
        case 'secret-gemini-key':
          return await this.verifyGemini(rawValue);
        case 'secret-aws-access-key':
          return unsupported(
            'AWS access key IDs require the paired AWS secret access key to sign a request (e.g. STS GetCallerIdentity) - a bare access key ID cannot be verified alone.',
          );
        case 'secret-twilio':
          return unsupported(
            'Twilio API Keys (SK...) require a paired Account SID/secret that this scanner does not reliably capture alongside the key.',
          );
        case 'secret-mongodb-uri':
        case 'secret-redis-uri':
        case 'secret-postgres-uri':
        case 'secret-mysql-uri':
          return unsupported(
            'Verifying this would require opening a live connection to a third-party database server, which this tool does not do.',
          );
        case 'secret-firebase-key':
          return unsupported(
            'Generic Google API keys are often scoped to a specific API; there is no single endpoint that reliably confirms validity without knowing which API the key is restricted to.',
          );
        case 'secret-firebase-service-account':
          return unsupported(
            'Verifying a service-account key requires signing a JWT assertion and exchanging it for an OAuth2 token - not implemented.',
          );
        default:
          return unsupported(
            'No safe, provider-specific way to verify this credential type.',
          );
      }
    } catch (error) {
      this.logger.warn(
        `Credential verification error for rule ${ruleId}: ${(error as Error).message}`,
      );
      return {
        status: 'error',
        detail: 'Verification check failed unexpectedly (see server logs).',
        checkedAt: new Date(),
      };
    }
  }

  private async verifyGitHub(token: string): Promise<VerificationResult> {
    try {
      const res = await axios.get<{ login?: string }>(
        'https://api.github.com/user',
        {
          headers: { Authorization: `token ${token}` },
          timeout: TIMEOUT_MS,
          validateStatus: () => true,
        },
      );
      if (res.status === 200) {
        return {
          status: 'active',
          detail: `GitHub confirms this token is active${res.data?.login ? ` (authenticates as "${res.data.login}")` : ''}.`,
          checkedAt: new Date(),
        };
      }
      if (res.status === 401) {
        return {
          status: 'invalid',
          detail: 'GitHub rejected this token (401) - not currently valid.',
          checkedAt: new Date(),
        };
      }
      return this.inconclusive('GitHub', res.status);
    } catch (error) {
      return this.networkError('GitHub', error);
    }
  }

  private async verifyStripe(key: string): Promise<VerificationResult> {
    try {
      const res = await axios.get('https://api.stripe.com/v1/balance', {
        headers: { Authorization: `Bearer ${key}` },
        timeout: TIMEOUT_MS,
        validateStatus: () => true,
      });
      if (res.status === 200) {
        return {
          status: 'active',
          detail: 'Stripe confirms this live secret key is active.',
          checkedAt: new Date(),
        };
      }
      if (res.status === 401) {
        return {
          status: 'invalid',
          detail: 'Stripe rejected this key (401) - not currently valid.',
          checkedAt: new Date(),
        };
      }
      return this.inconclusive('Stripe', res.status);
    } catch (error) {
      return this.networkError('Stripe', error);
    }
  }

  private async verifySlack(token: string): Promise<VerificationResult> {
    try {
      const res = await axios.post<{ ok: boolean; error?: string }>(
        'https://slack.com/api/auth.test',
        undefined,
        {
          headers: { Authorization: `Bearer ${token}` },
          timeout: TIMEOUT_MS,
          validateStatus: () => true,
        },
      );
      if (res.data?.ok) {
        return {
          status: 'active',
          detail: 'Slack confirms this token is active.',
          checkedAt: new Date(),
        };
      }
      return {
        status: 'invalid',
        detail: `Slack rejected this token${res.data?.error ? ` (${res.data.error})` : ''}.`,
        checkedAt: new Date(),
      };
    } catch (error) {
      return this.networkError('Slack', error);
    }
  }

  private async verifyAnthropic(key: string): Promise<VerificationResult> {
    try {
      const res = await axios.get('https://api.anthropic.com/v1/models', {
        headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        timeout: TIMEOUT_MS,
        validateStatus: () => true,
      });
      if (res.status === 200) {
        return {
          status: 'active',
          detail: 'Anthropic confirms this API key is active.',
          checkedAt: new Date(),
        };
      }
      if (res.status === 401) {
        return {
          status: 'invalid',
          detail: 'Anthropic rejected this key (401) - not currently valid.',
          checkedAt: new Date(),
        };
      }
      return this.inconclusive('Anthropic', res.status);
    } catch (error) {
      return this.networkError('Anthropic', error);
    }
  }

  private async verifyOpenAI(key: string): Promise<VerificationResult> {
    try {
      const res = await axios.get('https://api.openai.com/v1/models', {
        headers: { Authorization: `Bearer ${key}` },
        timeout: TIMEOUT_MS,
        validateStatus: () => true,
      });
      if (res.status === 200) {
        return {
          status: 'active',
          detail: 'OpenAI confirms this API key is active.',
          checkedAt: new Date(),
        };
      }
      if (res.status === 401) {
        return {
          status: 'invalid',
          detail: 'OpenAI rejected this key (401) - not currently valid.',
          checkedAt: new Date(),
        };
      }
      return this.inconclusive('OpenAI', res.status);
    } catch (error) {
      return this.networkError('OpenAI', error);
    }
  }

  private async verifyDiscordBot(token: string): Promise<VerificationResult> {
    try {
      const res = await axios.get('https://discord.com/api/v10/users/@me', {
        headers: { Authorization: `Bot ${token}` },
        timeout: TIMEOUT_MS,
        validateStatus: () => true,
      });
      if (res.status === 200) {
        return {
          status: 'active',
          detail: 'Discord confirms this bot token is active.',
          checkedAt: new Date(),
        };
      }
      if (res.status === 401) {
        return {
          status: 'invalid',
          detail:
            'Discord rejected this bot token (401) - not currently valid.',
          checkedAt: new Date(),
        };
      }
      return this.inconclusive('Discord', res.status);
    } catch (error) {
      return this.networkError('Discord', error);
    }
  }

  /** The webhook URL itself is the "credential" here - GET reads its info without posting a message. */
  private async verifyDiscordWebhook(
    webhookUrl: string,
  ): Promise<VerificationResult> {
    try {
      const res = await axios.get(webhookUrl, {
        timeout: TIMEOUT_MS,
        validateStatus: () => true,
      });
      if (res.status === 200) {
        return {
          status: 'active',
          detail: 'Discord confirms this webhook is still active.',
          checkedAt: new Date(),
        };
      }
      if (res.status === 404 || res.status === 401) {
        return {
          status: 'invalid',
          detail:
            'Discord reports this webhook no longer exists or is invalid.',
          checkedAt: new Date(),
        };
      }
      return this.inconclusive('Discord webhook', res.status);
    } catch (error) {
      return this.networkError('Discord webhook', error);
    }
  }

  private async verifyTelegram(token: string): Promise<VerificationResult> {
    try {
      const res = await axios.get<{ ok: boolean }>(
        `https://api.telegram.org/bot${token}/getMe`,
        { timeout: TIMEOUT_MS, validateStatus: () => true },
      );
      if (res.data?.ok) {
        return {
          status: 'active',
          detail: 'Telegram confirms this bot token is active.',
          checkedAt: new Date(),
        };
      }
      return {
        status: 'invalid',
        detail: 'Telegram rejected this bot token - not currently valid.',
        checkedAt: new Date(),
      };
    } catch (error) {
      return this.networkError('Telegram', error);
    }
  }

  private async verifySendGrid(key: string): Promise<VerificationResult> {
    try {
      const res = await axios.get('https://api.sendgrid.com/v3/scopes', {
        headers: { Authorization: `Bearer ${key}` },
        timeout: TIMEOUT_MS,
        validateStatus: () => true,
      });
      if (res.status === 200) {
        return {
          status: 'active',
          detail: 'SendGrid confirms this API key is active.',
          checkedAt: new Date(),
        };
      }
      if (res.status === 401) {
        return {
          status: 'invalid',
          detail: 'SendGrid rejected this key (401) - not currently valid.',
          checkedAt: new Date(),
        };
      }
      return this.inconclusive('SendGrid', res.status);
    } catch (error) {
      return this.networkError('SendGrid', error);
    }
  }

  private async verifyGemini(key: string): Promise<VerificationResult> {
    try {
      const res = await axios.get(
        'https://generativelanguage.googleapis.com/v1/models',
        { params: { key }, timeout: TIMEOUT_MS, validateStatus: () => true },
      );
      if (res.status === 200) {
        return {
          status: 'active',
          detail: 'Google confirms this Gemini API key is active.',
          checkedAt: new Date(),
        };
      }
      if (res.status === 400 || res.status === 403) {
        return {
          status: 'invalid',
          detail: 'Google rejected this key - not currently valid.',
          checkedAt: new Date(),
        };
      }
      return this.inconclusive('Gemini', res.status);
    } catch (error) {
      return this.networkError('Gemini', error);
    }
  }

  private inconclusive(provider: string, status: number): VerificationResult {
    return {
      status: 'error',
      detail: `${provider} returned an unexpected status (${status}) - could not conclusively verify.`,
      checkedAt: new Date(),
    };
  }

  private networkError(provider: string, error: unknown): VerificationResult {
    this.logger.warn(
      `${provider} verification request failed: ${(error as Error).message}`,
    );
    return {
      status: 'error',
      detail: `Could not reach ${provider} to verify this credential (network/timeout).`,
      checkedAt: new Date(),
    };
  }
}
