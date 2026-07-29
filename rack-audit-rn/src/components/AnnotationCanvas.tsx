import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Svg, { Path } from 'react-native-svg';
import type { EvidenceStroke } from '@/lib/types';

function strokeToPath(stroke: EvidenceStroke): string {
  if (!stroke.points.length) return '';
  const [first, ...rest] = stroke.points;
  return `M${first.x} ${first.y} ${rest.map((p) => `L${p.x} ${p.y}`).join(' ')}`;
}

// Ports setupImageAnnotationCanvas/drawImageAnnotationStroke (source
// ~3056-3111) — freehand strokes as SVG <Path> elements rather than the
// source's canvas clearRect-and-replay-every-frame technique (which its own
// comment calls a workaround): committed strokes and the in-progress one
// each get their own <Path>, so RN never has to manually redraw history.
export function AnnotationCanvas({
  width,
  height,
  strokes,
  color,
  drawMode,
  onStrokeComplete,
}: {
  width: number;
  height: number;
  strokes: EvidenceStroke[];
  color: string;
  drawMode: boolean;
  onStrokeComplete: (stroke: EvidenceStroke) => void;
}) {
  const [current, setCurrent] = useState<EvidenceStroke | null>(null);

  const pan = Gesture.Pan()
    .enabled(drawMode)
    .minDistance(0)
    .onBegin((e) => setCurrent({ color, points: [{ x: e.x, y: e.y }] }))
    .onChange((e) => setCurrent((c) => (c ? { ...c, points: [...c.points, { x: e.x, y: e.y }] } : c)))
    .onFinalize(() => {
      setCurrent((c) => {
        if (c && c.points.length > 1) onStrokeComplete(c);
        return null;
      });
    });

  return (
    <GestureDetector gesture={pan}>
      <View style={{ width, height }}>
        <Svg width={width} height={height} style={StyleSheet.absoluteFill}>
          {strokes.map((s, i) => (
            <Path key={i} d={strokeToPath(s)} stroke={s.color} strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" fill="none" />
          ))}
          {current ? <Path d={strokeToPath(current)} stroke={current.color} strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" fill="none" /> : null}
        </Svg>
      </View>
    </GestureDetector>
  );
}
