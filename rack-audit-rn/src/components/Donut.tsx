import Svg, { Circle, Text as SvgText } from 'react-native-svg';
import { useTheme } from '@/theme/ThemeProvider';

// Ports the Dashboard's "Task Progress" donut (source lines ~1829-1839): a
// stroke-dashoffset ring plus a centered percentage label.
export function Donut({ pct, size = 56 }: { pct: number; size?: number }) {
  const { tokens } = useTheme();
  const r = size / 2 - 6;
  const c = 2 * Math.PI * r;
  const center = size / 2;
  return (
    <Svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <Circle cx={center} cy={center} r={r} fill="none" stroke={tokens.muted} strokeWidth={6} />
      <Circle
        cx={center}
        cy={center}
        r={r}
        fill="none"
        stroke={tokens.primary}
        strokeWidth={6}
        strokeLinecap="round"
        strokeDasharray={`${c} ${c}`}
        strokeDashoffset={c - (pct / 100) * c}
        rotation={-90}
        origin={`${center}, ${center}`}
      />
      <SvgText x={center} y={center} textAnchor="middle" dy={4} fontSize={12} fontWeight="800" fill={tokens.foreground}>
        {`${pct}%`}
      </SvgText>
    </Svg>
  );
}
