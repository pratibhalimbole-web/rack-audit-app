import { StyleSheet, Text, View } from 'react-native';
import { useTheme } from '@/theme/ThemeProvider';
import type { UiStatus } from '@/lib/auditLogic';
import type { Priority } from '@/lib/types';

// Ports the .pill s-* / p-* CSS classes (rack-audit-app.html lines 259-267):
// same soft-background/strong-foreground pairing per status/priority value,
// picked from RAG + accent tokens rather than the source's raw hex classes.
export type PillTone = UiStatus | Priority;

const TONE_KEY: Record<PillTone, 'red' | 'amber' | 'green' | 'accentBlue' | 'accentPurple'> = {
  'To Do': 'accentBlue',
  'In Progress': 'accentPurple',
  Completed: 'green',
  Overdue: 'red',
  High: 'red',
  Medium: 'amber',
  Low: 'green',
};

export function Pill({ label, tone }: { label: string; tone: PillTone }) {
  const { tokens } = useTheme();
  const key = TONE_KEY[tone];
  const colors =
    key === 'accentBlue'
      ? { bg: tokens.accentBlue.soft, fg: tokens.accentBlue.strong }
      : key === 'accentPurple'
        ? { bg: tokens.accentPurple.soft, fg: tokens.accentPurple.strong }
        : { bg: tokens.rag[key].soft, fg: tokens.rag[key].strong };

  return (
    <View style={[styles.pill, { backgroundColor: colors.bg, borderRadius: tokens.radius.sm }]}>
      <View style={[styles.dot, { backgroundColor: colors.fg }]} />
      <Text style={{ color: colors.fg, fontSize: tokens.text.xxs, fontWeight: tokens.fontWeight.semibold }} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 10, paddingVertical: 3, alignSelf: 'flex-start' },
  dot: { width: 6, height: 6, borderRadius: 3 },
});
