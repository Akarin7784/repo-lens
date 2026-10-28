import { App } from './app'; // cycle app <-> helper
export const helper = (n: number) => n + (App ? 1 : 0);
