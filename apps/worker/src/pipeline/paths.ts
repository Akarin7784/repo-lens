/**
 * 仓库内相对路径的安全校验,实现移到 @repolens/shared(T-213 `/files` 共用)。
 * 扫描阶段本身不跟随符号链接,这里再对进入分析/入库的每条路径兜一层。
 */
export { safeRelPath } from '@repolens/shared';
