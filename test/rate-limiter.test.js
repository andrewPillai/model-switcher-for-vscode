'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isNvidiaNimEndpoint,
  getRpmLimit,
  waitForRateLimit,
  resetLimiter,
  getLimiterStatus,
  TokenBucketLimiter,
  DEFAULT_NVIDIA_NIM_RPM
} = require('../src/rate-limiter');

test('identifies NVIDIA NIM endpoints', () => {
  assert.equal(isNvidiaNimEndpoint('https://integrate.api.nvidia.com/v1/chat/completions'), true);
  assert.equal(isNvidiaNimEndpoint('https://api.nvidia.com/v1/chat/completions'), true);
  assert.equal(isNvidiaNimEndpoint('https://integrate.api.nvidia.com/v1'), true);
  assert.equal(isNvidiaNimEndpoint('https://api.openai.com/v1/chat/completions'), false);
  assert.equal(isNvidiaNimEndpoint('https://example.com/v1/chat/completions'), false);
  assert.equal(isNvidiaNimEndpoint('not-a-url'), false);
});

test('returns 40 RPM for NVIDIA NIM endpoints', () => {
  const profile = { endpoint: 'https://integrate.api.nvidia.com/v1/chat/completions' };
  assert.equal(getRpmLimit(profile), DEFAULT_NVIDIA_NIM_RPM);
  assert.equal(DEFAULT_NVIDIA_NIM_RPM, 40);
});

test('returns user-configured RPM limit for non-NVIDIA endpoints', () => {
  const profile = { endpoint: 'https://api.openai.com/v1/chat/completions', rpmLimit: 60 };
  assert.equal(getRpmLimit(profile), 60);
});

test('returns 0 (unlimited) when no rpmLimit configured for non-NVIDIA', () => {
  const profile = { endpoint: 'https://api.openai.com/v1/chat/completions' };
  assert.equal(getRpmLimit(profile), 0);
});

test('returns 0 (unlimited) when rpmLimit explicitly set to 0', () => {
  const profile = { endpoint: 'https://api.openai.com/v1/chat/completions', rpmLimit: 0 };
  assert.equal(getRpmLimit(profile), 0);
});

test('TokenBucketLimiter allows immediate requests up to RPM', async () => {
  const limiter = new TokenBucketLimiter(10);
  for (let i = 0; i < 10; i++) {
    assert.equal(limiter.tryConsume(), true);
  }
  assert.equal(limiter.tryConsume(), false);
});

test('TokenBucketLimiter refills tokens over time', async () => {
  const limiter = new TokenBucketLimiter(60); // 1 per second
  limiter.tryConsume(); // Use 1 token
  assert.equal(limiter.tokens, 59);
  
  // Advance time by 1 second (mock)
  limiter.lastRefill -= 1000;
  limiter.refill();
  assert.equal(limiter.tokens, 60);
});

test('waitForRateLimit resolves immediately for unlimited endpoints', async () => {
  const profile = { endpoint: 'https://api.openai.com/v1/chat/completions', rpmLimit: 0 };
  await assert.doesNotReject(waitForRateLimit(profile));
});

test('waitForRateLimit works for NVIDIA NIM with 40 RPM', async () => {
  // Use a fresh endpoint to avoid interference from other tests
  const profile = { endpoint: 'https://integrate.api.nvidia.com/v1/chat/completions', rpmLimit: 40 };
  resetLimiter(profile.endpoint);
  
  // First request should be immediate
  const start = Date.now();
  await waitForRateLimit(profile);
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 100); // Should be nearly instant
});

test('getLimiterStatus returns correct info for NVIDIA NIM', () => {
  const profile = { endpoint: 'https://integrate.api.nvidia.com/v1/chat/completions' };
  resetLimiter(profile.endpoint);
  const status = getLimiterStatus(profile);
  assert.equal(status.limited, true);
  assert.equal(status.rpm, 40);
  assert.equal(status.isNvidiaNim, true);
  assert.ok(status.tokensAvailable <= 40);
});

test('getLimiterStatus returns unlimited for non-limited endpoints', () => {
  const profile = { endpoint: 'https://api.openai.com/v1/chat/completions', rpmLimit: 0 };
  const status = getLimiterStatus(profile);
  assert.equal(status.limited, false);
  assert.equal(status.rpm, 0);
  assert.equal(status.tokensAvailable, Infinity);
});

test('TokenBucketLimiter respects abort signal', async () => {
  const limiter = new TokenBucketLimiter(1); // Very slow refill
  limiter.tokens = 0; // No tokens available
  
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 10);
  
  await assert.rejects(
    limiter.waitForToken(controller.signal),
    /Aborted/
  );
});
