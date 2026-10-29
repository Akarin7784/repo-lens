'use client';
/**
 * T-230 dev 预览(仅 `next dev` 可访问,生产构建不含此页):用假问答流驱动 ChatPanel,用于截图与手工检查。
 * 页面内容全部是假数据,未接真实后端。
 */
import { ChatPanel } from '../../../components/chat/ChatPanel';
import { createFakeTransport, DEMO_SCRIPT } from '../../../dev/fakeChatStream';

const transport = createFakeTransport(DEMO_SCRIPT, { delayMs: 120 });

export default function ChatDevPage() {
  return (
    <main className="flex h-screen justify-center bg-bg">
      <div className="flex w-[420px] flex-col border-x border-line">
        <p className="border-b border-line bg-panel px-4 py-2 text-[12px] text-muted">
          dev 预览 · 假数据(假 SSE 流),未接真实后端
        </p>
        <div className="min-h-0 flex-1">
          <ChatPanel repoId={1} transport={transport} onCitationClick={() => {}} />
        </div>
      </div>
    </main>
  );
}
