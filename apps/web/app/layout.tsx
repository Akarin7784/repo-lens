import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Inter, JetBrains_Mono, Noto_Serif_SC, Source_Serif_4 } from 'next/font/google';
import { THEME_BOOT_SCRIPT } from '../components/theme/theme';
import './globals.css';

const serif = Source_Serif_4({
  subsets: ['latin'],
  variable: '--font-source-serif',
  display: 'swap',
});
// 中文标题回退:Google Fonts 按 unicode-range 分片,只下载页面用到的字;不 preload、swap,不阻塞首屏
const serifSC = Noto_Serif_SC({
  weight: ['600'],
  variable: '--font-noto-serif-sc',
  display: 'swap',
  preload: false,
});
const sans = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' });
const mono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-jetbrains', display: 'swap' });

export const metadata: Metadata = {
  title: 'RepoLens',
  description: '把一个 TypeScript 仓库变成可以点开看的依赖地图',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="zh-CN"
      data-theme="light"
      suppressHydrationWarning
      className={`${serif.variable} ${serifSC.variable} ${sans.variable} ${mono.variable}`}
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
      </head>
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
