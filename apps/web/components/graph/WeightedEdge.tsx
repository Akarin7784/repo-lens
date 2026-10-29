'use client';
import { memo } from 'react';
import {
  BaseEdge,
  EdgeLabelRenderer,
  getSmoothStepPath,
  useStore,
  type EdgeProps,
  type ReactFlowState,
} from '@xyflow/react';
import {
  edgeOpacity,
  edgeWidth,
  showWeightLabel,
  WEIGHT_LABEL_MIN_ZOOM,
  type RepoFlowEdge,
} from '../../lib/graph/toFlow';
import { hoverHighlight } from '../../lib/graph/hover';
import { useHoverTouches } from './HoverContext';

// 布尔 selector:只有跨过阈值时才触发重渲染,缩放过程中不会每帧重渲染所有边
const zoomedInSelector = (s: ReactFlowState) => s.transform[2] >= WEIGHT_LABEL_MIN_ZOOM;

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
  // T-221:悬停只在无选中时叠加(选中优先),只有与悬停节点相连的边因布尔订阅翻转而重渲染
  const hoverOn = useHoverTouches(props.source, props.target);
  const hl = hoverHighlight(data?.highlight, hoverOn);
  const cycle = data?.cycle === true;
  const typeOnly = !cycle && data?.kind === 'type-only';
  const base = hl === 'on' || cycle ? 'var(--accent-strong)' : 'var(--edge)';
  const zoomedIn = useStore(zoomedInSelector);
  const opacity = edgeOpacity({ highlight: hl, cycle, aggregated, kind: data?.kind });
  const label = showWeightLabel({ highlight: hl, cycle, aggregated, weight }, zoomedIn);
  const hoverAttr = hoverOn && data?.highlight === undefined ? 'on' : undefined;
  return (
    <g
      className="rl-edge"
      data-hover={hoverAttr}
      data-testid={`edge-${props.id}`}
      data-hl={hl ?? 'none'}
    >
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
            data-hover={hoverAttr}
            title="循环依赖"
            className="rl-edge-label pointer-events-none absolute rounded-full bg-accent-strong px-1 text-[10px] leading-4 text-on-accent"
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY - 14}px)`,
            }}
          >
            ↻
          </div>
        </EdgeLabelRenderer>
      )}
      {label && (
        <EdgeLabelRenderer>
          <div
            data-testid={`agg-weight-${props.id}`}
            data-hover={hoverAttr}
            title={`聚合 ${weight} 条依赖`}
            className="rl-edge-label pointer-events-none absolute rounded-full border border-line bg-panel px-1.5 text-[10px] text-muted"
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          >
            ×{weight}
          </div>
        </EdgeLabelRenderer>
      )}
    </g>
  );
});

export const edgeTypes = { weighted: WeightedEdge };
