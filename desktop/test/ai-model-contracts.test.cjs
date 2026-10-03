'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { contractCatalog, SUPPORTED_MODEL } = require('../src/ai-model-contracts.cjs');

const contract = () => contractCatalog({ provider: 'openai', model: SUPPORTED_MODEL, operation: 'CHAT' });
const approval = (outputTokenMax = '2048') => ({ model: SUPPORTED_MODEL, operation: 'CHAT', outputTokenMax });
function body() {
  return { model: SUPPORTED_MODEL,
    messages: [{ role: 'system', content: 'Synthetic instructions.' }, { role: 'user', content: 'Synthetic question.' }],
    max_completion_tokens: 2048, response_format: { type: 'json_object' }, stream: false, n: 1,
    store: false, service_tier: 'default' };
}
function response() {
  return { model: SUPPORTED_MODEL, service_tier: 'default',
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120,
      prompt_tokens_details: { cached_tokens: 40 } } };
}
function unavailable(error) {
  assert.equal(error.message, 'AI usage unavailable');
  assert.equal(error.cause, undefined);
  return true;
}

// Public model documentation was checked on 2026-10-03. This test performs no network calls.
// https://developers.openai.com/api/docs/models/gpt-4o-mini
// https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create
test('reviewed snapshot has explicit standard rates, limits and immutable metadata', () => {
  const value = contract();
  assert.equal(SUPPORTED_MODEL, 'gpt-4o-mini-2024-07-18');
  assert.equal(value.provider, 'openai');
  assert.equal(value.endpointId, 'openai.chat');
  assert.equal(value.operation, 'CHAT');
  assert.equal(value.verifiedAtEpochMs, Date.parse('2026-10-03T00:00:00Z'));
  assert.equal(value.inputTokenLimit, '128000');
  assert.equal(value.outputTokenLimit, '16384');
  assert.equal(value.embeddingTokenLimit, '0');
  assert.equal(value.tokenizerId, 'provider-context-ceiling');
  assert.deepEqual(value.rates, { inputMicroUsdPerMillion: '150000', cachedInputMicroUsdPerMillion: '75000',
    outputMicroUsdPerMillion: '600000', embeddingMicroUsdPerMillion: '0', fixedMicroUsd: '0' });
  assert.equal(Object.isFrozen(value), true);
  assert.equal(Object.isFrozen(value.rates), true);
  assert.throws(() => { value.rates.inputMicroUsdPerMillion = '0'; }, TypeError);
  assert.throws(() => { value.model = 'gpt-4o-mini'; }, TypeError);
  assert.equal(contract(), value);
  assert.match(value.priceSha256, /^[a-f0-9]{64}$/);
  assert.match(value.costContractSha256, /^[a-f0-9]{64}$/);
  const expectedPrice = crypto.createHash('sha256').update(JSON.stringify({ model: SUPPORTED_MODEL,
    verifiedAt: value.verifiedAtEpochMs, rates: value.rates })).digest('hex');
  assert.equal(value.priceSha256, expectedPrice);
  assert.notEqual(value.priceSha256, value.costContractSha256);
});

for (const [label, query] of [
  ['floating alias', { provider: 'openai', model: 'gpt-4o-mini', operation: 'CHAT' }],
  ['different snapshot', { provider: 'openai', model: 'gpt-4o-mini-2099-01-01', operation: 'CHAT' }],
  ['Gemini', { provider: 'gemini', model: 'gemini-flash', operation: 'CHAT' }],
  ['different provider with same model', { provider: 'gemini', model: SUPPORTED_MODEL, operation: 'CHAT' }],
  ['embedding', { provider: 'openai', model: SUPPORTED_MODEL, operation: 'EMBED' }],
  ['lowercase operation', { provider: 'openai', model: SUPPORTED_MODEL, operation: 'chat' }],
  ['provider case variant', { provider: 'OpenAI', model: SUPPORTED_MODEL, operation: 'CHAT' }],
  ['missing fields', {}],
]) test(`catalog fails closed for ${label}`, () => assert.equal(contractCatalog(query), null));

test('input reservation uses the full context ceiling for short and long prompts without a tokenizer request', () => {
  const value = contract();
  for (const prompt of ['', 'small', 'x'.repeat(200000)]) {
    const request = body(); request.messages[1].content = prompt;
    const bound = value.inputBound(request, approval());
    assert.deepEqual(bound, { inputTokens: '128000', embeddingInputTokens: '0' });
    assert.equal(Object.isFrozen(bound), true);
  }
});

test('only the approved plain-text body and exact output cap are accepted', () => {
  assert.equal(contract().validateBody(body(), approval()), true);
  for (const limit of [1, 16384]) {
    const request = body(); request.max_completion_tokens = limit;
    assert.equal(contract().validateBody(request, approval(String(limit))), true);
  }
});

for (const key of ['model', 'messages', 'max_completion_tokens', 'response_format', 'stream', 'n', 'store', 'service_tier']) {
  test(`body rejects missing required ${key}`, () => {
    const request = body(); delete request[key];
    assert.equal(contract().validateBody(request, approval()), false);
  });
}

for (const [label, mutate] of [
  ['tool definitions', request => { request.tools = []; }],
  ['tool choice', request => { request.tool_choice = 'none'; }],
  ['audio options', request => { request.audio = { voice: 'alloy', format: 'wav' }; }],
  ['audio modality', request => { request.modalities = ['text', 'audio']; }],
  ['prediction', request => { request.prediction = { type: 'content', content: 'prediction' }; }],
  ['legacy token cap', request => { request.max_tokens = 2048; }],
  ['streaming', request => { request.stream = true; }],
  ['storage', request => { request.store = true; }],
  ['multiple completions', request => { request.n = 2; }],
  ['priority tier', request => { request.service_tier = 'priority'; }],
  ['automatic tier', request => { request.service_tier = 'auto'; }],
  ['model alias', request => { request.model = 'gpt-4o-mini'; }],
  ['JSON schema output', request => { request.response_format = { type: 'json_schema' }; }],
  ['extra format property', request => { request.response_format.extra = true; }],
  ['developer role', request => { request.messages[0].role = 'developer'; }],
  ['reversed roles', request => { request.messages.reverse(); }],
  ['extra conversation turn', request => { request.messages.push({ role: 'assistant', content: 'extra' }); }],
  ['missing system turn', request => { request.messages.shift(); }],
  ['multimodal content', request => { request.messages[1].content = [{ type: 'text', text: 'hello' }]; }],
  ['null content', request => { request.messages[1].content = null; }],
  ['message metadata', request => { request.messages[1].name = 'caller'; }],
]) test(`body rejects ${label}`, () => {
  const request = body(); mutate(request);
  assert.equal(contract().validateBody(request, approval()), false);
});

for (const limit of [0, -1, 16385, 1.5, '2048', null, Number.MAX_SAFE_INTEGER + 1]) {
  test(`body rejects invalid output cap ${JSON.stringify(limit)}`, () => {
    const request = body(); request.max_completion_tokens = limit;
    assert.equal(contract().validateBody(request, approval(String(limit))), false);
  });
}
for (const [label, approved] of [
  ['different output cap', approval('2049')], ['noncanonical output cap', approval('02048')],
  ['different operation', { ...approval(), operation: 'EMBED' }],
  ['different model', { ...approval(), model: 'gpt-4o-mini' }],
]) test(`body rejects ${label} in the approval contract`, () => {
  assert.equal(contract().validateBody(body(), approved), false);
});

test('usage preserves cached tokens as a subset of total input instead of double counting', () => {
  const value = contract().readUsage(response());
  assert.deepEqual(value, { inputTokens: '100', cachedInputTokens: '40', outputTokens: '20', embeddingInputTokens: '0' });
  assert.equal(Object.isFrozen(value), true);
});
test('explicit all-zero usage is available while missing usage is not', () => {
  const value = response();
  value.usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, prompt_tokens_details: { cached_tokens: 0 } };
  assert.deepEqual(contract().readUsage(value), { inputTokens: '0', cachedInputTokens: '0', outputTokens: '0', embeddingInputTokens: '0' });
  delete value.usage;
  assert.throws(() => contract().readUsage(value), unavailable);
});
test('ceiling usage and fully cached input remain distinct valid dimensions', () => {
  const value = response();
  value.usage = { prompt_tokens: 128000, completion_tokens: 16384, total_tokens: 144384,
    prompt_tokens_details: { cached_tokens: 128000 } };
  assert.deepEqual(contract().readUsage(value), { inputTokens: '128000', cachedInputTokens: '128000', outputTokens: '16384', embeddingInputTokens: '0' });
});

for (const key of ['prompt_tokens', 'completion_tokens', 'total_tokens', 'prompt_tokens_details']) {
  test(`usage rejects missing ${key} instead of assuming zero`, () => {
    const value = response(); delete value.usage[key];
    assert.throws(() => contract().readUsage(value), unavailable);
  });
}
test('usage requires explicit cached_tokens, even for uncached requests', () => {
  const value = response(); delete value.usage.prompt_tokens_details.cached_tokens;
  assert.throws(() => contract().readUsage(value), unavailable);
  value.usage.prompt_tokens_details.cached_tokens = 0;
  assert.equal(contract().readUsage(value).cachedInputTokens, '0');
});

for (const [label, mutate] of [
  ['model alias', value => { value.model = 'gpt-4o-mini'; }],
  ['missing model', value => { delete value.model; }],
  ['missing tier', value => { delete value.service_tier; }],
  ['different tier', value => { value.service_tier = 'priority'; }],
  ['null usage', value => { value.usage = null; }],
  ['array usage', value => { value.usage = []; }],
  ['null prompt details', value => { value.usage.prompt_tokens_details = null; }],
  ['array prompt details', value => { value.usage.prompt_tokens_details = []; }],
  ['null completion details', value => { value.usage.completion_tokens_details = null; }],
  ['array completion details', value => { value.usage.completion_tokens_details = []; }],
  ['unknown top-level usage dimension even at zero', value => { value.usage.unknown_tokens = 0; }],
  ['unknown input dimension even at zero', value => { value.usage.prompt_tokens_details.unknown_tokens = 0; }],
  ['unknown output dimension even at zero', value => { value.usage.completion_tokens_details = { unknown_tokens: 0 }; }],
  ['inconsistent total', value => { value.usage.total_tokens = 119; }],
  ['cache exceeds input', value => { value.usage.prompt_tokens_details.cached_tokens = 101; }],
  ['input exceeds ceiling', value => { value.usage.prompt_tokens = 128001; value.usage.total_tokens = 128021; }],
  ['output exceeds ceiling', value => { value.usage.completion_tokens = 16385; value.usage.total_tokens = 16485; }],
  ['input text detail mismatch', value => { value.usage.prompt_tokens_details.text_tokens = 99; }],
  ['output text detail mismatch', value => { value.usage.completion_tokens_details = { text_tokens: 19 }; }],
]) test(`usage rejects ${label}`, () => {
  const value = response(); mutate(value);
  assert.throws(() => contract().readUsage(value), unavailable);
});

for (const [label, invalid] of [['negative', -1], ['fractional', 0.5], ['unsafe integer', Number.MAX_SAFE_INTEGER + 1],
  ['numeric string', '0'], ['null', null], ['boolean', false], ['nonfinite', Infinity]]) {
  test(`usage rejects ${label} in every required numeric dimension`, () => {
    for (const key of ['prompt_tokens', 'completion_tokens', 'total_tokens', 'cached_tokens']) {
      const value = response();
      if (key === 'cached_tokens') value.usage.prompt_tokens_details[key] = invalid;
      else value.usage[key] = invalid;
      assert.throws(() => contract().readUsage(value), unavailable, key);
    }
  });
}

for (const [group, names] of [['prompt_tokens_details', ['audio_tokens', 'image_tokens', 'cache_write_tokens']],
  ['completion_tokens_details', ['audio_tokens', 'reasoning_tokens', 'accepted_prediction_tokens', 'rejected_prediction_tokens']]]) {
  for (const name of names) {
    test(`usage accepts explicit zero and rejects billable or malformed ${group}.${name}`, () => {
      for (const amount of [0, 1, -1, 0.5, '0', null]) {
        const value = response(); value.usage[group] ??= {}; value.usage[group][name] = amount;
        if (amount === 0) assert.equal(contract().readUsage(value).outputTokens, '20');
        else assert.throws(() => contract().readUsage(value), unavailable);
      }
    });
  }
}
test('matching optional text details and zero nontext details retain exact ordinary usage', () => {
  const value = response();
  Object.assign(value.usage.prompt_tokens_details, { text_tokens: 100, audio_tokens: 0, image_tokens: 0, cache_write_tokens: 0 });
  value.usage.completion_tokens_details = { text_tokens: 20, audio_tokens: 0, reasoning_tokens: 0,
    accepted_prediction_tokens: 0, rejected_prediction_tokens: 0 };
  assert.deepEqual(contract().readUsage(value), contract().readUsage(response()));
});
