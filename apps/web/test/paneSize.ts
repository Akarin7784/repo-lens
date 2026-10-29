/**
 * T-241:React Flow 用 pane 的 getBoundingClientRect 作为 d3-zoom extent。jsdom 下恒为 0,
 * 带 duration 的 setViewport 插值会除以 0 → 视口 NaN(MiniMap 报「Received NaN」)。
 * setup 里给 .react-flow__renderer 一个默认尺寸;测试可把它改成 0 复现隐藏面板。
 */
export const paneSize = { width: 1000, height: 700 };
export const DEFAULT_PANE = { width: 1000, height: 700 };
