import App, { createApp } from './core/app';
import { formatDate } from '@utils';
import type { Config } from '@core/types';
export * from './features';
export const cfg: Config = { name: 'x' };
export async function lazy() { const m = await import('./features/b/heavy'); return m.heavy(); }
export default function main() { return createApp(new App(), formatDate(new Date())); }
