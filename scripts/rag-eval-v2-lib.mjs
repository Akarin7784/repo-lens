// 兼容旧入口:v2 的解析与判分,内部转调可配置的 rag-eval-holdout-lib.mjs(逻辑不变)。
import { HOLDOUTS, parseHoldout, okFile, judge } from './rag-eval-holdout-lib.mjs';

export const ZOD_SHA = HOLDOUTS.v2.commit;
export const V4_PREFIX = HOLDOUTS.v2.prefix;
export const V2_EXPECTED_ROWS = HOLDOUTS.v2.expectedRows;

export function parseHoldoutV2(md, expectedRows = V2_EXPECTED_ROWS) {
  return parseHoldout(md, {
    idLetter: 'V',
    prefix: V4_PREFIX,
    expectedRows,
    file: 'RAG_HOLDOUT_V2.md',
  });
}
export const okFileV2 = (path, want) => okFile(path, want, V4_PREFIX);
export const judgeV2 = (paths, want) => judge(paths, want, V4_PREFIX);
