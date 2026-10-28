export type AnalyzerErrorCode = 'UNSUPPORTED_LANGUAGE' | 'PARSER_UNAVAILABLE';

export class AnalyzerError extends Error {
  constructor(
    readonly code: AnalyzerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AnalyzerError';
  }
}
