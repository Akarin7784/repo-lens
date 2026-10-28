import type { ProgressStage } from '@repolens/shared';

export type PipelineErrorCode =
  | 'CLONE_FAILED'
  | 'CLONE_TIMEOUT'
  | 'COMMIT_MISMATCH'
  | 'REPO_TOO_LARGE'
  | 'UNSUPPORTED_LANGUAGE'
  | 'UNSAFE_PATH'
  | 'PARSER_UNAVAILABLE'
  | 'INTERNAL';

/** retryable=false 的错误不再重试(BullMQ UnrecoverableError),例如超限、非 TS 仓库 */
export class PipelineError extends Error {
  constructor(
    readonly code: PipelineErrorCode,
    readonly stage: ProgressStage,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'PipelineError';
  }
}
