/**
 * Failure taxonomy for one upstream attempt — the JavaScript twin of
 * internal/scheduler/failure_reason.go.
 *
 * The Hub and the Full node must report the same vocabulary for the same
 * upstream failure, so this file mirrors the Go rules one for one:
 *  - classifyFailure() maps (status, body, kind) onto the closed reason enum
 *    and the upstream's own machine code (err_type);
 *  - normalizeToken()/extractRequestId() bound every upstream-supplied token
 *    to [a-z0-9_] so it cannot smuggle log delimiters;
 *  - compressError() collapses an upstream body to one short line.
 *
 * Enum values are frozen by shared/contracts/admin-ui-backend.json v3.11.
 * If Go gains a value, this file gains the same value in the same commit.
 */

export const REASON = Object.freeze({
  AUTH_INVALID: 'auth_invalid',
  QUOTA_EXHAUSTED: 'quota_exhausted',
  RATE_LIMITED: 'rate_limited',
  MODEL_NOT_FOUND: 'model_not_found',
  CONTEXT_TOO_LONG: 'context_too_long',
  UPSTREAM_ERROR: 'upstream_error',
  TIMEOUT: 'timeout',
  NETWORK: 'network',
  CLIENT_DISCONNECTED: 'client_disconnected',
  BAD_RESPONSE: 'bad_response',
  PROTOCOL_MISMATCH: 'protocol_mismatch',
  NO_CANDIDATE: 'no_candidate',
  CONFIG_UNAVAILABLE: 'config_unavailable',
  UNKNOWN: 'unknown',
});

export const FAILURE_KIND = Object.freeze({
  HTTP: 'http',
  NETWORK: 'network',
  TIMEOUT: 'timeout',
  CLIENT_ABORT: 'client_abort',
  BAD_RESPONSE: 'bad_response',
});

export const FAILURE_REASONS = Object.freeze(Object.values(REASON));

const DEFAULT_ERROR_TEXT_MAX = 280;
const MAX_ERR_TYPE_LEN = 64;
const MAX_REQUEST_ID_LEN = 128;

/** Lowercase, keep only [a-z0-9_], cap at max bytes (ASCII, so bytes == runes). */
export function normalizeToken(value, max = MAX_ERR_TYPE_LEN) {
  const out = String(value == null ? '' : value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '');
  return max > 0 && out.length > max ? out.slice(0, max) : out;
}

function jsonScalar(value) {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

/**
 * leadingMachineCode returns the head token of a message only when it looks
 * like a machine code ("insufficient_quota: ..."), not prose.
 */
function leadingMachineCode(message) {
  const msg = String(message == null ? '' : message).trim();
  if (!msg) return '';
  const m = msg.match(/^[A-Za-z0-9_]+/);
  if (!m) return '';
  const token = m[0];
  if (!token.includes('_')) return '';
  const rest = msg.slice(token.length).trim();
  if (rest && rest[0] !== ':' && rest[0] !== '-' && rest[0] !== '(') return '';
  return token;
}

/**
 * extractErrType pulls the upstream machine code out of an error body, trying
 * the same shapes as the Go implementation: error.type, error.code, type, code,
 * then a machine-code token at the head of error.message. Non-object bodies
 * yield ''.
 */
export function extractErrType(bodyText) {
  const text = String(bodyText == null ? '' : bodyText).trim();
  if (!text || text[0] !== '{') return '';
  let root;
  try {
    root = JSON.parse(text);
  } catch (_) {
    return '';
  }
  if (!root || typeof root !== 'object' || Array.isArray(root)) return '';

  if (root.error !== undefined && root.error !== null) {
    const err = root.error;
    if (typeof err === 'object' && !Array.isArray(err)) {
      for (const key of ['type', 'code']) {
        const v = jsonScalar(err[key]);
        if (v) return v;
      }
      if (typeof err.message === 'string') {
        const v = leadingMachineCode(err.message);
        if (v) return v;
      }
    } else if (typeof err === 'string') {
      const v = leadingMachineCode(err);
      if (v) return v;
    }
  }

  for (const key of ['type', 'code']) {
    const v = jsonScalar(root[key]);
    if (v) return v;
  }
  return '';
}

const QUOTA_MARKERS = ['insufficient_quota', 'quota', 'balance', 'credit', 'billing', '余额', '欠费'];
// Throttling markers win over quota markers on a 429: providers label the error
// type "quota_exceeded_error" while the message says "rps exhausted" (SenseNova,
// observed 2026-11-27). Must stay identical to internal/scheduler/failure_reason.go.
const THROTTLE_MARKERS = [
  'rps', 'rpm', 'tpm', 'rate limit', 'ratelimit', 'too many requests',
  'concurrency', 'throttl', 'capacity', 'retry in', 'retry after', '限流', '请稍后重试',
];
const CONTEXT_MARKERS = ['context_length', 'context length', 'too long', 'max_tokens', 'maximum context'];

function containsAny(haystack, needles) {
  return needles.some((n) => haystack.includes(n));
}

function classifyHTTPStatus(status, bodyText) {
  const body = String(bodyText == null ? '' : bodyText).toLowerCase();
  if (status === 401 || status === 403) return REASON.AUTH_INVALID;
  if (status === 402) return REASON.QUOTA_EXHAUSTED;
  if (status === 429) {
    // 429 is overloaded: throttling vs an empty account. Only the body says
    // which — and the operator action differs (raise RPM vs top up). A throttle
    // marker wins, because an "rps exhausted" body often carries a quota-ish
    // error type as well.
    if (containsAny(body, THROTTLE_MARKERS)) return REASON.RATE_LIMITED;
    return containsAny(body, QUOTA_MARKERS) ? REASON.QUOTA_EXHAUSTED : REASON.RATE_LIMITED;
  }
  if (status === 404 && body.includes('model')) return REASON.MODEL_NOT_FOUND;
  if (status === 400 && containsAny(body, CONTEXT_MARKERS)) return REASON.CONTEXT_TOO_LONG;
  if (status >= 500 && status <= 599) return REASON.UPSTREAM_ERROR;
  return REASON.UNKNOWN;
}

/**
 * classifyFailure maps one failed attempt onto { reason, err_type }.
 * kind is one of FAILURE_KIND; HTTP (or anything unknown) falls back to the
 * status rules so a caller that forgets the kind still gets a useful bucket.
 */
export function classifyFailure(status, errBody, kind = FAILURE_KIND.HTTP) {
  const errType = normalizeToken(extractErrType(errBody), MAX_ERR_TYPE_LEN);
  const numericStatus = Number(status) || 0;

  switch (kind) {
    case FAILURE_KIND.NETWORK:
      return { reason: REASON.NETWORK, err_type: errType };
    case FAILURE_KIND.TIMEOUT:
      return { reason: REASON.TIMEOUT, err_type: errType };
    case FAILURE_KIND.CLIENT_ABORT:
      return { reason: REASON.CLIENT_DISCONNECTED, err_type: errType };
    case FAILURE_KIND.BAD_RESPONSE:
      return { reason: REASON.BAD_RESPONSE, err_type: errType };
    default:
      return { reason: classifyHTTPStatus(numericStatus, errBody), err_type: errType };
  }
}

/** Header lookup order for the upstream correlation id (same as Go). */
export const REQUEST_ID_HEADERS = Object.freeze([
  'x-request-id',
  'request-id',
  'x-amzn-requestid',
  'x-ms-request-id',
  'cf-ray',
]);

function getHeader(headers, name) {
  if (!headers) return '';
  if (typeof headers.get === 'function') {
    const v = headers.get(name);
    return v == null ? '' : String(v);
  }
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (String(k).toLowerCase() === lower && v != null) return String(v);
  }
  return '';
}

/** First present upstream request id, normalized like err_type, max 128. */
export function extractRequestId(headers) {
  for (const name of REQUEST_ID_HEADERS) {
    const v = String(getHeader(headers, name) || '').trim();
    if (v) return normalizeToken(v, MAX_REQUEST_ID_LEN);
  }
  return '';
}

/** Collapse an upstream body / error string to one line, cut at max chars. */
export function compressError(value, max = DEFAULT_ERROR_TEXT_MAX) {
  const limit = max > 0 ? max : DEFAULT_ERROR_TEXT_MAX;
  const text = String(value == null ? '' : value).trim();
  if (!text) return '';
  const oneLine = text.replace(/\s+/g, ' ');
  const chars = Array.from(oneLine);
  const cut = chars.length > limit ? chars.slice(0, limit).join('') : oneLine;
  return cut.trim();
}