import '@testing-library/jest-dom/vitest';

// React Flow 依赖 ResizeObserver / DOMMatrix,jsdom 没有
class RO {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver ??= RO as unknown as typeof ResizeObserver;
// @ts-expect-error minimal stub
globalThis.DOMMatrixReadOnly ??= class {
  m22 = 1;
  constructor() {}
};

// vitest 未开 globals,testing-library 不会自动 cleanup;多个用例共用 document 时需手动卸载
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';
afterEach(cleanup);
