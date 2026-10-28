'use client';
import { memo } from 'react';
import { BaseEdge, EdgeLabelRenderer, getSmoothStepPath, type EdgeProps } from '@xyflow/react';
import { edgeWidth, type RepoFlowEdge } from '../../lib/graph/toFlow';

const DASH: Record<string, string | undefined> = { 'type-only': '2 4', dynamic: '6 4' };

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
  return (
    <>
      <BaseEdge
        path={path}
        markerEnd={markerEnd}
        style={{
          stroke: 'var(--edge)',
          strokeWidth: edgeWidth(weight, aggregated),
          strokeOpacity: aggregated ? 0.75 : 0.9,
          strokeDasharray: DASH[data?.kind ?? ''],
        }}
      />
      {aggregated && weight > 1 && (
        <EdgeLabelRenderer>
          <div
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
