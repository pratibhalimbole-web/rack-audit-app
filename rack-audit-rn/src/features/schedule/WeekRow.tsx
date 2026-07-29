import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { Audit } from '@/lib/types';
import { useTheme } from '@/theme/ThemeProvider';
import { buildWeekRowData, CAL_TO_ISO, scheduleTypeKey } from './scheduleLogic';

// Ports buildScheduleWeekRow()'s HTML output (rack-audit-app.html
// ~3409-3441) — one Mon-Sun row of day cells plus lane-stacked audit bars.
// RN has no CSS grid, so bars are positioned with left/width percentages
// over a relatively-positioned row matching the 7 day cells above it.
export function WeekRow({
  weekDates,
  refMonth,
  todayISO,
  auditPool,
  onDayPress,
}: {
  weekDates: Date[];
  refMonth: number | null;
  todayISO: string;
  auditPool: Audit[];
  onDayPress: (iso: string) => void;
}) {
  const { tokens } = useTheme();
  const { hiddenByCol, laneRows } = buildWeekRowData(weekDates, auditPool);
  const typeColor = {
    spot: tokens.accentBlue,
    full: tokens.accentPurple,
    cycle: tokens.rag.amber,
  };

  return (
    <View style={{ marginBottom: 6 }}>
      <View style={styles.dayRow}>
        {weekDates.map((d) => {
          const iso = CAL_TO_ISO(d);
          const inMonth = refMonth == null || d.getMonth() === refMonth;
          const isToday = iso === todayISO;
          return (
            <Pressable key={iso} onPress={() => onDayPress(iso)} style={styles.dayCell}>
              <View style={[styles.dayNumWrap, isToday ? { backgroundColor: tokens.primary, borderRadius: 999 } : null]}>
                <Text
                  style={{
                    color: isToday ? tokens.primaryForeground : inMonth ? tokens.foreground : tokens.slate400,
                    fontSize: tokens.text.xs,
                    fontWeight: tokens.fontWeight.semibold,
                  }}
                >
                  {d.getDate()}
                </Text>
              </View>
            </Pressable>
          );
        })}
      </View>

      {laneRows.map((row, i) => (
        <View key={i} style={styles.barRow}>
          {row.map((b) => {
            const c = typeColor[scheduleTypeKey(b.audit.audit_type)];
            return (
              <Pressable
                key={`${b.audit.audit_id}-${b.colStart}`}
                onPress={() => onDayPress(b.spanStartISO)}
                style={[styles.bar, { left: `${(b.colStart / 7) * 100}%`, width: `${(b.colSpan / 7) * 100}%`, backgroundColor: c.soft, borderRadius: tokens.radius.sm }]}
              >
                <Text numberOfLines={1} style={{ color: c.strong, fontSize: 9, fontWeight: '700' }}>
                  {b.audit.audit_type}
                </Text>
              </Pressable>
            );
          })}
        </View>
      ))}

      {hiddenByCol.some((n) => n > 0) ? (
        <View style={styles.dayRow}>
          {hiddenByCol.map((n, i) => (
            <View key={i} style={styles.dayCell}>
              {n > 0 ? <Text style={{ color: tokens.mutedForeground, fontSize: 9, fontWeight: '700' }}>+{n} More</Text> : null}
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  dayRow: { flexDirection: 'row' },
  dayCell: { flex: 1, alignItems: 'center', paddingVertical: 4 },
  dayNumWrap: { width: 26, height: 26, alignItems: 'center', justifyContent: 'center' },
  barRow: { height: 18, position: 'relative', marginTop: 2 },
  bar: { position: 'absolute', top: 0, bottom: 0, justifyContent: 'center', paddingHorizontal: 6, marginHorizontal: 2 },
});
