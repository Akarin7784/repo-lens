import type { ReactNode } from 'react';

export const metadata = { title: 'RepoLens', description: '代码仓库架构图与问答' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body
        style={{ margin: 0, background: '#F5F1E8', color: '#1F1E1D', fontFamily: 'Georgia, serif' }}
      >
        {children}
      </body>
    </html>
  );
}
