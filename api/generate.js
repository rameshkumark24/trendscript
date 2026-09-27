import { requestGroqJson, requireApiKey, resolveModel } from '../lib/groq.js';
import { assertPost, readJsonBody, sendError, sendJson } from '../lib/http.js';
import { cleanText, pickOption, requireText } from '../lib/input.js';
import { normalizePackage } from '../lib/normalize.js';
import { DEFAULT_TONE, TONES } from '../lib/options.js';
import { buildPackageMessages } from '../lib/prompts.js';
import { createRateLimiter, enforceRateLimit } from '../lib/rate-limit.js';

/**
 * POST /api/generate  { topic, niche?, tone? }
 * -> { package: { title, thumbnail_idea, caption, hashtags, chapters, script } }
 */
export function createGenerateHandler({ env = process.env, fetchImpl, logger = console } = {}) {
  const limiter = createRateLimiter();

  return async function generateHandler(req, res) {
    try {
      assertPost(req);
      enforceRateLimit(limiter, req, env);
      const body = readJsonBody(req);
      const topic = requireText(body.topic, { label: 'Topic', maxLength: 150, minLength: 3 });
      const niche = cleanText(body.niche, 80);
      const tone = pickOption(body.tone, Object.keys(TONES), DEFAULT_TONE);
      const apiKey = requireApiKey(env);

      const productionPackage = await requestGroqJson({
        apiKey,
        model: resolveModel(env),
        messages: buildPackageMessages({ topic, niche, tone }),
        validate: (raw) => normalizePackage(raw, { topic }),
        temperature: 0.8,
        maxTokens: 1200,
        timeoutMs: 15_000,
        fetchImpl: fetchImpl ?? globalThis.fetch,
        logger,
      });

      sendJson(res, 200, { package: productionPackage, tone });
    } catch (error) {
      sendError(res, error, logger);
    }
  };
}

export default createGenerateHandler();
