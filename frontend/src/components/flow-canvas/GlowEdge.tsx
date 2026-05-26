import {
  BaseEdge,
  EdgeLabelRenderer,
  EdgeProps,
  getSmoothStepPath,
} from "@xyflow/react";


/**
 * Custom edge that paints a sky-blue glow as a separate SVG path
 * beneath the regular dashed edge, plus a fast-drifting dashed
 * stroke on top.
 *
 * We did this as a custom component (rather than CSS on React
 * Flow's default edge) because:
 *
 *   1. ``filter: drop-shadow`` on a single <path> gets clipped to
 *      the path's bbox on Chrome/Safari — the glow appears not to
 *      render even when the rule is applied.
 *   2. Beating RF's built-in ``.react-flow__edge.animated path``
 *      selector with custom CSS is fragile and load-order
 *      dependent.
 *
 * A custom edge gives us total control over the SVG output and
 * sidesteps both problems.
 *
 * Data the parent (FlowEditor) passes via the ``data`` prop:
 *   - ``stroke``: the main stroke color (branch color or run
 *     status color)
 *   - ``strokeWidth``: main stroke width
 *   - ``branchLabel``: optional "true" / "false" label text
 *   - ``labelColor``: color for the label text
 */
export interface GlowEdgeData {
  stroke?: string;
  strokeWidth?: number;
  branchLabel?: string;
  labelColor?: string;
  [key: string]: unknown;
}


export default function GlowEdge(props: EdgeProps) {
  const {
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    data,
    markerEnd,
    selected,
  } = props;
  const d = (data ?? {}) as GlowEdgeData;
  const stroke = d.stroke ?? "#64748b";
  const strokeWidth = d.strokeWidth ?? 1.5;

  // Smooth-step routing mirrors React Flow's default look. We pass
  // the same path string to all three layers (glow, main, label
  // anchor) so they trace the same curve exactly.
  const [edgePath, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  // Halo layer: a wide, sky-blue, low-opacity stroke beneath the
  // main line. Selected edges get a brighter / wider halo so click
  // feedback reads. Sits in front of the canvas but behind the main
  // dashed stroke.
  const haloWidth = selected ? 18 : 12;
  const haloOpacity = selected ? 0.55 : 0.3;

  return (
    <>
      {/* Glow */}
      <path
        d={edgePath}
        stroke="#38bdf8"
        strokeWidth={haloWidth}
        strokeOpacity={haloOpacity}
        strokeLinecap="round"
        fill="none"
        style={{ filter: "blur(3px)" }}
      />
      {/* Main dashed stroke (with the arrowhead marker) */}
      <BaseEdge
        id={props.id}
        path={edgePath}
        markerEnd={markerEnd}
        style={{
          stroke,
          strokeWidth,
          strokeDasharray: "8 5",
          animation: "canvas-edge-flow 0.9s linear infinite",
        }}
      />
      {d.branchLabel && (
        <EdgeLabelRenderer>
          <div
            style={{
              position: "absolute",
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              background: "#0f172a",
              padding: "1px 5px",
              borderRadius: 4,
              color: d.labelColor ?? "#94a3b8",
              fontSize: 11,
              fontWeight: 600,
              pointerEvents: "all",
            }}
            className="nodrag nopan"
          >
            {d.branchLabel}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}
