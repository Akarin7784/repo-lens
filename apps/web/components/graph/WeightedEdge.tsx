'use client';
import { memo } from 'react';
import { BaseEdge, EdgeLabelRenderer, getSmoothStepPath, type EdgeProps } from '@xyflow/react';
import { edgeWidth, type RepoFlowEdge } from '../../lib/graph/toFlow';

// type-only:更淡的圆点线;dynamic:短虚线;环边:--accent-strong 长虚线 + 中点 ↻ 标记(优先级最高)
const DASH: Record<string, string | undefined> = { 'type-only': '1 5', dynamic: '6 4' };
const CYCLE_DASH = '8 4';

/** 聚合边按 weight 定粗细并标注 weight;type-only 点线、dynamic 短虚线 */
export const WeightedEdge = memo(function WeightedEdge(props: EdgeProps<RepoFlowEdge>) {
  const { sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, markerEnd } =
    props;
  const [path, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    borderRadius: 10,
  });
  const weight = data?.weight ?? 1;
  const aggregated = data?.aggregated ?? false;
  const hl = data?.highlight;
  const cycle = data?.cycle === true;
  const typeOnly = !cycle && data?.kind === 'type-only';
  const base = hl === 'on' || cycle ? 'var(--accent-strong)' : 'var(--edge)';
  const opacity = hl === 'dim' ? 0.15 : typeOnly ? 0.55 : aggregated ? 0.75 : 0.9;
  return (
    <>
      <BaseEdge
        path={path}
        markerEnd={markerEnd}
        style={{
          stroke: base,
          strokeWidth: edgeWidth(weight, aggregated) + (hl === 'on' || cycle ? 0.75 : 0),
          strokeOpacity: opacity,
          strokeDasharray: cycle ? CYCLE_DASH : DASH[data?.kind ?? ''],
          strokeLinecap: typeOnly ? 'round' : undefined,
        }}
      />
      {aggregated && (
        <path
          d={path}
          fill="none"
          stroke="transparent"
          strokeWidth={14}
          data-testid={`agg-hit-${props.id}`}
        >
          <title>{`聚合边:${weight} 条依赖`}</title>
        </path>
      )}
      {cycle && hl !== 'dim' && (
        <EdgeLabelRenderer>
          <div
            data-testid={`cycle-mark-${props.id}`}
            title="循环依赖"
            className="pointer-events-none absolute rounded-full bg-accent-strong px-1 text-[10px] leading-4 text-on-accent"
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY - 14}px)`,
            }}
          >
            ↻
          </div>
        </EdgeLabelRenderer>
      )}
      {aggregated && weight > 1 && hl !== 'dim' && (
        <EdgeLabelRenderer>
          <div
            data-testid={`agg-weight-${props.id}`}
            title={`聚合 ${weight} 条依赖`}
            className="pointer-events-none absolute rounded-full border border-line bg-panel px-1.5 text-[10px] text-muted"
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          >
            ×{weight}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
});

export const edgeTypes = { weighted: WeightedEdge };
