import { StyleSheet, View } from 'react-native';
import { useTheme } from '@/theme/ThemeProvider';

// Ports .progress-track/.progress-fill (source lines ~200-210).
export function ProgressBar({ pct }: { pct: number }) {
  const { tokens } = useTheme();
  const clamped = Math.max(0, Math.min(100, pct));
  return (
    <View style={[styles.track, { backgroundColor: tokens.muted, borderRadius: tokens.radius.sm }]}>
      <View style={[styles.fill, { width: `${clamped}%`, backgroundColor: tokens.primary, borderRadius: tokens.radius.sm }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  track: { height: 8, width: '100%', overflow: 'hidden' },
  fill: { height: '100%' },
});
