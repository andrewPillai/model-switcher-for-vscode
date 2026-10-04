'use strict';

/**
 * Token bucket rate limiter for API requests.
 * NVIDIA NIM free tier has a hard limit of 40 RPM.
 * Other endpoints can have user-configured limits.
 */

const NVIDIA_NIM_ENDPOINT_PATTERNS = [
  'integrate.api.nvidia.com',
  'api.nvidia.com'
];

const DEFAULT_NVIDIA_NIM_RPM = 40;

/**
 * Check if an endpoint is a NVIDIA NIM endpoint
 * @param {string} endpoint - The API endpoint URL
 * @returns {boolean} True if it's a NVIDIA NIM endpoint
 */
function isNvidiaNimEndpoint(endpoint) {
  try {
    const url = new URL(endpoint);
    return NVIDIA_NIM_ENDPOINT_PATTERNS.some(pattern => url.hostname.includes(pattern));
  } catch {
    return false;
  }
}

/**
 * Get the RPM limit for an endpoint
 * @param {Object} profile - The model profile
 * @returns {number} RPM limit (requests per minute)
 */
function getRpmLimit(profile) {
  // NVIDIA NIM has a hard limit of 40 RPM
  if (isNvidiaNimEndpoint(profile.endpoint)) {
    return DEFAULT_NVIDIA_NIM_RPM;
  }
  // User-configured limit, or unlimited (0)
  return profile.rpmLimit || 0;
}

/**
 * Token bucket rate limiter class
 */
class TokenBucketLimiter {
  constructor(rpm) {
    this.rpm = rpm;
    this.tokens = rpm;
    this.lastRefill = Date.now();
  }

  /**
   * Refill tokens based on elapsed time
   */
  refill() {
    const now = Date.now();
    const elapsedMinutes = (now - this.lastRefill) / 60000;
    const newTokens = Math.floor(elapsedMinutes * this.rpm);
    if (newTokens > 0) {
      this.tokens = Math.min(this.rpm, this.tokens + newTokens);
      this.lastRefill = now;
    }
  }

  /**
   * Try to consume a token, returns true if successful
   * @returns {boolean}
   */
  tryConsume() {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  /**
   * Wait for a token to become available
   * @param {AbortSignal} signal - Optional abort signal
   * @returns {Promise<void>}
   */
  async waitForToken(signal) {
    // If unlimited, no wait needed
    if (this.rpm === 0) {
      return;
    }

    // Try immediate consume
    if (this.tryConsume()) {
      return;
    }

    // Wait for token refill
    return new Promise((resolve, reject) => {
      const checkInterval = setInterval(() => {
        if (signal?.aborted) {
          clearInterval(checkInterval);
          reject(new DOMException('Aborted', 'AbortError'));
          return;
        }
        if (this.tryConsume()) {
          clearInterval(checkInterval);
          resolve();
        }
      }, 100); // Check every 100ms

      // Also set a timeout based on when next token will be available
      this.refill();
      const tokensNeeded = 1 - this.tokens;
      const msUntilNextToken = Math.ceil((tokensNeeded / this.rpm) * 60000);
      const timeout = setTimeout(() => {
        clearInterval(checkInterval);
        // Try one more time after timeout
        if (this.tryConsume()) {
          resolve();
        } else {
          reject(new Error('Rate limit timeout'));
        }
      }, msUntilNextToken + 1000); // Add 1 second buffer

      // Cleanup on resolve/reject
      const originalResolve = resolve;
      const originalReject = reject;
      resolve = (...args) => {
        clearInterval(checkInterval);
        clearTimeout(timeout);
        originalResolve(...args);
      };
      reject = (...args) => {
        clearInterval(checkInterval);
        clearTimeout(timeout);
        originalReject(...args);
      };
    });
  }
}

// Global limiter instances per endpoint
const limiters = new Map();

/**
 * Get or create a limiter for an endpoint
 * @param {Object} profile - The model profile
 * @returns {TokenBucketLimiter}
 */
function getLimiter(profile) {
  const endpointKey = profile.endpoint;
  const rpm = getRpmLimit(profile);

  if (!limiters.has(endpointKey)) {
    limiters.set(endpointKey, new TokenBucketLimiter(rpm));
  } else if (limiters.get(endpointKey).rpm !== rpm) {
    // RPM limit changed, recreate limiter
    limiters.set(endpointKey, new TokenBucketLimiter(rpm));
  }

  return limiters.get(endpointKey);
}

/**
 * Wait for rate limit token before making a request
 * @param {Object} profile - The model profile
 * @param {AbortSignal} signal - Optional abort signal
 * @returns {Promise<void>}
 */
async function waitForRateLimit(profile, signal) {
  const rpm = getRpmLimit(profile);
  if (rpm === 0) {
    return; // No limit
  }

  const limiter = getLimiter(profile);
  await limiter.waitForToken(signal);
}

/**
 * Reset limiter for an endpoint (useful for testing)
 * @param {string} endpoint - The endpoint URL
 */
function resetLimiter(endpoint) {
  limiters.delete(endpoint);
}

/**
 * Get current limiter status for an endpoint
 * @param {Object} profile - The model profile
 * @returns {Object} Status info
 */
function getLimiterStatus(profile) {
  const rpm = getRpmLimit(profile);
  if (rpm === 0) {
    return { limited: false, rpm: 0, tokensAvailable: Infinity };
  }

  const limiter = getLimiter(profile);
  limiter.refill();
  return {
    limited: true,
    rpm,
    tokensAvailable: limiter.tokens,
    isNvidiaNim: isNvidiaNimEndpoint(profile.endpoint)
  };
}

module.exports = {
  isNvidiaNimEndpoint,
  getRpmLimit,
  waitForRateLimit,
  resetLimiter,
  getLimiterStatus,
  TokenBucketLimiter,
  DEFAULT_NVIDIA_NIM_RPM
};
