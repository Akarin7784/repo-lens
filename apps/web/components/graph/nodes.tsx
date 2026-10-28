'use client';
import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { RepoFlowNode } from '../../lib/graph/toFlow';
import { useToggle } from './ToggleContext';

const ring = (selected: boolean | undefined) =>
  selected ? 'border-2 border-accent bg-cite' : 'border-[1.5px] border-node-stroke';

function Handles() {
  return (
    <>
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <Handle type="source" position={Position.Right} isConnectable={false} />
    </>
  );
}

function ToggleButton({ id, label, expanded }: { id: string; label: string; expanded: boolean }) {
  const toggle = useToggle();
  return (
    <button
      type="button"
      aria-label={`${expanded ? '收起' : '展开'} ${label}`}
      aria-expanded={expanded}
      className="nodrag rounded-control px-1.5 text-xs text-node-muted hover:text-accent-hover"
      onClick={(e) => {
        e.stopPropagation();
        toggle(id);
      }}
    >
      {expanded ? '▾' : '▸'}
    </button>
  );
}

/** module:最大、最深填充的圆角卡片,衬线标题;展开后变成容器 */
export const ModuleCard = memo(function ModuleCard({ data, selected }: NodeProps<RepoFlowNode>) {
  const { node, expanded, childCount, isContainer } = data;
  return (
    <div
      data-testid={`node-${node.id}`}
      className={`h-full w-full rounded-card shadow-soft ${ring(selected)} ${isContainer ? 'bg-node-container' : 'bg-node-module'}`}
    >
      <Handles />
      <div className="flex items-start justify-between gap-2 px-3 pt-2.5">
        <div className="min-w-0">
          <div className="truncate font-serif text-[15px] font-semibold leading-tight text-fg">
            {node.label}
          </div>
          <div className="truncate font-mono text-[11px] text-node-muted">
            {node.path === '.' ? '仓库根目录' : node.path}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {childCount !== undefined && (
            <span className="rounded-full border border-line bg-panel px-2 text-[11px] text-muted">
              {childCount} 项
            </span>
          )}
          <ToggleButton id={node.id} label={node.label} expanded={expanded} />
        </div>
      </div>
    </div>
  );
});

/** dir:中等尺寸、浅填充、10px 圆角 */
export const DirNode = memo(function DirNode({ data, selected }: NodeProps<RepoFlowNode>) {
  const { node, expanded, childCount, isContainer } = data;
  return (
    <div
      data-testid={`node-${node.id}`}
      className={`h-full w-full rounded-control bg-node-dir ${ring(selected)} ${isContainer ? 'bg-node-container' : ''}`}
    >
      <Handles />
      <div className="flex h-[44px] items-center justify-between gap-2 px-2.5">
        <span className="truncate text-[13px] font-medium text-fg">{node.label}/</span>
        <div className="flex shrink-0 items-center gap-1">
          {childCount !== undefined && (
            <span className="text-[11px] text-node-muted">{childCount}</span>
          )}
          <ToggleButton id={node.id} label={node.label} expanded={expanded} />
        </div>
      </div>
    </div>
  );
});

/** file:最小、白底胶囊、等宽字体 */
export const FileNode = memo(function FileNode({ data, selected }: NodeProps<RepoFlowNode>) {
  const { node } = data;
  return (
    <div
      data-testid={`node-${node.id}`}
      title={node.path}
      className={`flex h-full w-full items-center gap-1.5 rounded-full bg-node-file px-2.5 ${ring(selected)}`}
    >
      <Handles />
      <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-node-stroke" />
      <span className="truncate font-mono text-[12px] text-fg">{node.label}</span>
    </div>
  );
});

/** external:虚线胶囊(派生节点,默认隐藏) */
export const ExternalNode = memo(function ExternalNode({ data }: NodeProps<RepoFlowNode>) {
  return (
    <div
      data-testid={`node-${data.node.id}`}
      className="flex h-full w-full items-center rounded-full border-[1.5px] border-dashed border-node-stroke bg-node-external px-2.5"
    >
      <Handles />
      <span className="truncate font-mono text-[11px] text-muted">{data.node.label}</span>
    </div>
  );
});

/** 模块顶层定义,避免每次渲染生成新对象导致 React Flow 重建节点 */
export const nodeTypes = {
  module: ModuleCard,
  dir: DirNode,
  file: FileNode,
  external: ExternalNode,
};
