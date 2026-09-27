/**
 * An error that maps directly to an HTTP response. `message` is shown to the
 * user, so keep it human-readable and free of secrets.
 */
export class HttpError extends Error {
  constructor(status, message, { code = 'error', retryAfter, headers } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
    this.headers = headers;
  }
}

/**
 * The model answered, but the answer was unusable (not JSON, wrong shape,
 * missing fields). These are worth one retry because LLM output is stochastic.
 */
export class AiOutputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AiOutputError';
  }
}
