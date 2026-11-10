/**
 * Configuration, read once at startup.
 *
 * The model layer speaks one wire format, OpenAI chat completions, because
 * every major provider now exposes it. A provider is a base URL, a key and a
 * default model, so switching from Gemini to Groq or Claude is a line in .env.
 */
import { config as loadEnv } from 'dotenv';
import path from 'node:path';

loadEnv({ quiet: true });

export type Reasoning = 'none' | 'minimal' | 'low' | 'medium' | 'high';

interface Preset {
  baseUrl: string;
  keyEnv: string;
  model: string;
  fastModel?: string;
  /** Lowest thinking setting the provider accepts: thinking costs latency we do not want. */
  reasoning?: Reasoning;
  label: string;
}

const PRESETS: Record<string, Preset> = {
  gemini: {
    label: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    keyEnv: 'GEMINI_API_KEY',
    // Most reliably available first; overloaded models fall through to the next (see llm/client.ts).
    // 3.8 Flash returned 503 "high demand" on every free-tier call while this was built.
    model: 'gemini-3.5-flash,gemini-3.8-flash,gemini-3.5-flash-lite',
    fastModel: 'gemini-3.5-flash-lite',
    reasoning: 'low', // 3.x Flash rejects 'minimal'; 'low' is accepted across the chain
  },
  groq: {
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1/',
    keyEnv: 'GROQ_API_KEY',
    model: 'openai/gpt-oss-120b',
    reasoning: 'low',
  },
  anthropic: {
    label: 'Anthropic',
    baseUrl: 'https://api.anthropic.com/v1/',
    keyEnv: 'ANTHROPIC_API_KEY',
    model: 'claude-sonnet-5-5',
    fastModel: 'claude-haiku-5-5',
  },
  openai: {
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1/',
    keyEnv: 'OPENAI_API_KEY',
    model: 'gpt-5-mini',
    reasoning: 'minimal',
  },
  openrouter: {
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1/',
    keyEnv: 'OPENROUTER_API_KEY',
    model: 'google/gemini-3.8-flash,google/gemini-3.5-flash',
  },
};

export interface LlmConfig {
  provider: string;
  label: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Tried in order when the model is overloaded or rate limited. */
  fallbacks: string[];
  fastModel: string;
  reasoning?: Reasoning;
}

const list = (v: string) => v.split(',').map((s) => s.trim()).filter(Boolean);

function env(name: string): string | undefined {
  const v = process.env[name]?.trim();
  return v ? v : undefined;
}

function resolveLlm(): LlmConfig | null {
  const requested = env('LLM_PROVIDER')?.toLowerCase();

  if (requested === 'custom' || (!requested && env('LLM_BASE_URL'))) {
    const baseUrl = env('LLM_BASE_URL');
    const models = list(env('LLM_MODEL') ?? '');
    if (!baseUrl || !models.length) return null;
    return {
      provider: 'custom',
      label: new URL(baseUrl).host,
      baseUrl,
      apiKey: env('LLM_API_KEY') ?? 'none',
      model: models[0]!,
      fallbacks: models.slice(1),
      fastModel: env('LLM_FAST_MODEL') ?? models[0]!,
      reasoning: env('LLM_REASONING') as Reasoning | undefined,
    };
  }

  const name = requested ?? Object.keys(PRESETS).find((p) => env(PRESETS[p]!.keyEnv));
  const preset = name ? PRESETS[name] : undefined;
  const apiKey = preset && (env(preset.keyEnv) ?? env('LLM_API_KEY'));
  if (!name || !preset || !apiKey) return null;

  const models = list(env('LLM_MODEL') ?? preset.model);
  const reasoning = env('LLM_REASONING');
  return {
    provider: name,
    label: preset.label,
    baseUrl: env('LLM_BASE_URL') ?? preset.baseUrl,
    apiKey,
    model: models[0]!,
    fallbacks: models.slice(1),
    fastModel: env('LLM_FAST_MODEL') ?? preset.fastModel ?? models[0]!,
    reasoning: reasoning === 'off' ? undefined : ((reasoning as Reasoning | undefined) ?? preset.reasoning),
  };
}

/** Upstash Redis over REST. Vercel's marketplace integration sets the KV_* names. */
function resolveRedis(): { url: string; token: string } | null {
  const url = env('UPSTASH_REDIS_REST_URL') ?? env('KV_REST_API_URL');
  const token = env('UPSTASH_REDIS_REST_TOKEN') ?? env('KV_REST_API_TOKEN');
  return url && token ? { url, token } : null;
}

export const config = {
  port: Number(env('PORT') ?? 3000),
  dataDir: path.resolve(env('DATA_DIR') ?? 'data'),
  llm: resolveLlm(),
  tavilyKey: env('TAVILY_API_KEY'),
  redis: resolveRedis(),
  /** Running on a host with no writable disk (Vercel sets VERCEL=1). */
  hosted: !!env('VERCEL'),
  /** Origins allowed to call the API from a browser, e.g. a site embedding the agent. */
  corsOrigins: list(env('CORS_ORIGINS') ?? '*'),
};

/** What is missing, phrased for the person setting it up. Empty when ready. */
export function setupProblems(): string[] {
  const problems: string[] = [];
  if (!config.llm) {
    problems.push(
      env('LLM_PROVIDER')
        ? `LLM_PROVIDER=${env('LLM_PROVIDER')} is set but its API key (or LLM_BASE_URL and LLM_MODEL for custom) is missing.`
        : 'No model key. Add GEMINI_API_KEY to .env (free at https://aistudio.google.com/apikey).',
    );
  }
  if (!config.tavilyKey) problems.push('No search key. Add TAVILY_API_KEY to .env (free at https://app.tavily.com).');
  if (config.hosted && !config.redis) problems.push('No memory store: conversations last only while this server instance lives. Add Upstash Redis (free) from the Vercel Storage tab.');
  return problems;
}
