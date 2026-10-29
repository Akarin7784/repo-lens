import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import localFont from 'next/font/local';
import { THEME_BOOT_SCRIPT } from '../components/theme/theme';
import './globals.css';

// 字体随仓库自托管(T-225):构建和运行都不访问外网。文件来自 fontsource 的可变字体 latin 子集(OFL,见 ./fonts/LICENSES.md)。
// 中文不再加载网页字体,走系统字体回退(见 globals.css 的 --font-noto-serif-sc)。
const serif = localFont({
  src: './fonts/source-serif-4-latin-wght-normal.woff2',
  weight: '200 900',
  style: 'normal',
  variable: '--font-source-serif',
  display: 'swap',
  adjustFontFallback: 'Times New Roman',
});
const sans = localFont({
  src: './fonts/inter-latin-wght-normal.woff2',
  weight: '100 900',
  style: 'normal',
  variable: '--font-inter',
  display: 'swap',
  adjustFontFallback: 'Arial',
});
const mono = localFont({
  src: './fonts/jetbrains-mono-latin-wght-normal.woff2',
  weight: '100 800',
  style: 'normal',
  variable: '--font-jetbrains',
  display: 'swap',
  adjustFontFallback: false,
});

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
      className={`${serif.variable} ${sans.variable} ${mono.variable}`}
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
      </head>
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
