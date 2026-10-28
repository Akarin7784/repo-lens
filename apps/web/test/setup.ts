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
