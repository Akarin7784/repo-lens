import type { ApiError } from '@repolens/shared';

type Code = ApiError['error']['code'];
const STATUS: Record<Code, number> = {
  BAD_REQUEST: 400,
  INVALID_REPO_URL: 400,
  REPO_NOT_FOUND: 404,
  REPO_NOT_READY: 409,
  REPO_TOO_LARGE: 413,
  UNSUPPORTED_LANGUAGE: 422,
  RATE_LIMITED: 429,
  INTERNAL: 500,
};

export class HttpError extends Error {
  readonly status: number;
  constructor(
    readonly code: Code,
    message: string,
  ) {
    super(message);
    this.status = STATUS[code];
  }
  body(): ApiError {
    return { error: { code: this.code, message: this.message } };
  }
}
