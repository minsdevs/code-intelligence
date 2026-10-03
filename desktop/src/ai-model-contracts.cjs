'use strict';

const crypto = require('node:crypto');

// Reviewed 2026-10-03. The gateway rejects this catalog after 30 days; no runtime refresh or alias.
// https://developers.openai.com/api/docs/models/gpt-4o-mini
// https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create
const MODEL = 'gpt-4o-mini-2024-07-18';
const VERIFIED_AT = Date.parse('2026-10-03T00:00:00Z');
const rates = Object.freeze({ inputMicroUsdPerMillion: '150000', cachedInputMicroUsdPerMillion: '75000',
  outputMicroUsdPerMillion: '600000', embeddingMicroUsdPerMillion: '0', fixedMicroUsd: '0' });
const sha = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
function object(value, required, optional = []) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && required.every(key => Object.hasOwn(value, key))
    && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
}
function count(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('AI usage unavailable');
  return value;
}
function zeroExtras(value, names) {
  for (const name of names) if (Object.hasOwn(value, name) && count(value[name]) !== 0)
    throw new Error('AI usage unavailable');
}
function validateBody(body, contract) {
  return object(body, ['model', 'messages', 'max_completion_tokens', 'response_format', 'stream', 'n', 'store', 'service_tier'])
    && body.model === MODEL && contract.model === MODEL && contract.operation === 'CHAT'
    && Number.isInteger(body.max_completion_tokens) && body.max_completion_tokens >= 1
    && body.max_completion_tokens <= 16384 && String(body.max_completion_tokens) === contract.outputTokenMax
    && body.stream === false && body.n === 1 && body.store === false && body.service_tier === 'default'
    && object(body.response_format, ['type']) && body.response_format.type === 'json_object'
    && Array.isArray(body.messages) && body.messages.length === 2
    && body.messages.every((message, index) => object(message, ['role', 'content'])
      && message.role === (index === 0 ? 'system' : 'user') && typeof message.content === 'string');
}
function inputBound() {
  // Deliberately a provider context ceiling, not an estimated token count. It covers framing and
  // tokenizer uncertainty without sending the prompt to a token-counting service or discounting cache.
  return Object.freeze({ inputTokens: '128000', embeddingInputTokens: '0' });
}
function readUsage(response) {
  const usage = response?.usage;
  if (response?.model !== MODEL || response?.service_tier !== 'default'
      || !object(usage, ['prompt_tokens', 'completion_tokens', 'total_tokens', 'prompt_tokens_details'], ['completion_tokens_details'])
      || !object(usage.prompt_tokens_details, ['cached_tokens'], ['audio_tokens', 'image_tokens', 'text_tokens', 'cache_write_tokens']))
    throw new Error('AI usage unavailable');
  const input = count(usage.prompt_tokens); const output = count(usage.completion_tokens);
  const cached = count(usage.prompt_tokens_details.cached_tokens);
  if (count(usage.total_tokens) !== input + output || cached > input || input > 128000 || output > 16384)
    throw new Error('AI usage unavailable');
  zeroExtras(usage.prompt_tokens_details, ['audio_tokens', 'image_tokens', 'cache_write_tokens']);
  if (Object.hasOwn(usage.prompt_tokens_details, 'text_tokens') && count(usage.prompt_tokens_details.text_tokens) !== input)
    throw new Error('AI usage unavailable');
  if (Object.hasOwn(usage, 'completion_tokens_details')) {
    const detail = usage.completion_tokens_details;
    if (!object(detail, [], ['audio_tokens', 'reasoning_tokens', 'accepted_prediction_tokens', 'rejected_prediction_tokens', 'text_tokens']))
      throw new Error('AI usage unavailable');
    zeroExtras(detail, ['audio_tokens', 'reasoning_tokens', 'accepted_prediction_tokens', 'rejected_prediction_tokens']);
    if (Object.hasOwn(detail, 'text_tokens') && count(detail.text_tokens) !== output)
      throw new Error('AI usage unavailable');
  }
  return Object.freeze({ inputTokens: String(input), cachedInputTokens: String(cached), outputTokens: String(output), embeddingInputTokens: '0' });
}
const metadata = Object.freeze({ provider: 'openai', model: MODEL, operation: 'CHAT', endpointId: 'openai.chat',
  adapterVersion: 'openai-chat-text-v1', tokenizerId: 'provider-context-ceiling', tokenizerVersion: 'gpt4omini-128000-v1',
  priceVersion: 'openai-gpt4omini-standard-2026-10-03', verifiedAtEpochMs: VERIFIED_AT,
  inputTokenLimit: '128000', embeddingTokenLimit: '0', outputTokenLimit: '16384', rates });
const contract = Object.freeze({ ...metadata, priceSha256: sha({ model: MODEL, verifiedAt: VERIFIED_AT, rates }),
  costContractSha256: sha({ ...metadata, schema: 'text-only-exact-usage-v1', cache: 'subset-of-input', serviceTier: 'default' }),
  validateBody, inputBound, readUsage });
function contractCatalog({ provider, model, operation }) {
  return provider === 'openai' && model === MODEL && operation === 'CHAT' ? contract : null;
}
module.exports = Object.freeze({ contractCatalog, SUPPORTED_MODEL: MODEL });
