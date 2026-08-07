import { Ionicons } from '@expo/vector-icons';
import { useMemo, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { AppHeader } from '@/components/AppHeader';
import { mine } from '@/lib/auditLogic';
import type { Audit } from '@/lib/types';
import { useTheme } from '@/theme/ThemeProvider';
import { useAudits } from '../dashboard/hooks';
import { DayAuditsList } from './DayAuditsList';
import { buildWeekRowData, CAL_TO_ISO, mondayIndex, scheduleTypeKey } from './scheduleLogic';

type CalView = 'month' | 'week' | 'day';
const VIEWS: { key: CalView; label: string }[] = [
  { key: 'month', label: 'Monthly' },
  { key: 'week', label: 'Weekly' },
  { key: 'day', label: 'Daily' },
];
const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const CELL_MIN_HEIGHT = 132;
const LANE_HEIGHT = 20;

// Tablet-only visual treatment for Audit Schedule's calendar grid — same
// underlying data/lane logic as the phone version (scheduleLogic.ts,
// unchanged), but a spacious bordered-cell grid instead of the phone's
// compact stacked layout: boxed weekday headers, boxed month-nav controls,
// a named event line (colored dot + audit name) on the day a bar starts
// with a plain continuation bar carrying it across the days it spans, red
// Sunday dates, and a distinct "today" vs. "selected day" cell treatment.
// Phone's ScheduleScreen/WeekRow are untouched — this is a separate
// component, not a shared one, per this app's per-device-layout convention.
export function ScheduleTablet() {
  const { tokens } = useTheme();
  const { data: audits = [] } = useAudits();
  const auditPool = useMemo(() => mine(audits), [audits]);

  const now = new Date();
  const [cal, setCal] = useState({ year: now.getFullYear(), month: now.getMonth(), day: now.getDate() });
  const [view, setView] = useState<CalView>('month');
  const [viewMenuOpen, setViewMenuOpen] = useState(false);
  const [modalDateISO, setModalDateISO] = useState<string | null>(null);
  const [selectedDateISO, setSelectedDateISO] = useState<string | null>(null);
  const todayISO = CAL_TO_ISO(new Date());

  const shiftMonth = (delta: number) => {
    const d = new Date(cal.year, cal.month + delta, 1);
    setCal({ year: d.getFullYear(), month: d.getMonth(), day: 1 });
  };
  const shiftWeek = (delta: number) => {
    const d = new Date(cal.year, cal.month, cal.day + delta * 7);
    setCal({ year: d.getFullYear(), month: d.getMonth(), day: d.getDate() });
  };
  const shiftDay = (delta: number) => {
    const d = new Date(cal.year, cal.month, cal.day + delta);
    setCal({ year: d.getFullYear(), month: d.getMonth(), day: d.getDate() });
  };
  const shift = (delta: number) => (view === 'week' ? shiftWeek(delta) : view === 'day' ? shiftDay(delta) : shiftMonth(delta));

  const openDay = (iso: string) => {
    setSelectedDateISO(iso);
    setModalDateISO(iso);
  };

  let toolbarLabel = '';
  if (view === 'week') {
    const anchor = new Date(cal.year, cal.month, cal.day);
    const weekStart = new Date(anchor);
    weekStart.setDate(anchor.getDate() - mondayIndex(anchor.getDay()));
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekStart.getDate() + 6);
    toolbarLabel = `${weekStart.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })} – ${weekEnd.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}`;
  } else if (view === 'day') {
    toolbarLabel = new Date(cal.year, cal.month, cal.day).toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  } else {
    toolbarLabel = new Date(cal.year, cal.month, 1).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
  }

  return (
    <View style={{ flex: 1, backgroundColor: tokens.muted }}>
      <AppHeader title="Audit Schedule" showBack menuItems={[{ label: 'Sync Now', onPress: () => {} }]} />
      <ScrollView contentContainerStyle={styles.body}>
        <View style={styles.toolbar}>
          <View style={styles.navGroup}>
            <Pressable onPress={() => shift(-1)} style={[styles.navBox, { backgroundColor: tokens.card, borderColor: tokens.border, borderRadius: tokens.radius.lg }]}>
              <Ionicons name="chevron-back" size={18} color={tokens.foreground} />
            </Pressable>
            <View style={[styles.labelBox, { backgroundColor: tokens.card, borderColor: tokens.border, borderRadius: tokens.radius.lg }]}>
              <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.base }}>{toolbarLabel}</Text>
            </View>
            <Pressable onPress={() => shift(1)} style={[styles.navBox, { backgroundColor: tokens.card, borderColor: tokens.border, borderRadius: tokens.radius.lg }]}>
              <Ionicons name="chevron-forward" size={18} color={tokens.foreground} />
            </Pressable>
          </View>

          <View>
            <Pressable
              onPress={() => setViewMenuOpen((o) => !o)}
              style={[styles.navBox, styles.viewSelectBox, { backgroundColor: tokens.card, borderColor: tokens.border, borderRadius: tokens.radius.lg }]}
            >
              <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.semibold, fontSize: tokens.text.base }}>
                {VIEWS.find((v) => v.key === view)!.label}
              </Text>
              <Ionicons name="chevron-down" size={16} color={tokens.mutedForeground} />
            </Pressable>
            {viewMenuOpen ? (
              <>
                <Pressable style={StyleSheet.absoluteFill} onPress={() => setViewMenuOpen(false)} />
                <View style={[styles.viewMenu, { backgroundColor: tokens.popover, borderColor: tokens.border, borderRadius: tokens.radius.lg }]}>
                  {VIEWS.map((v) => (
                    <Pressable
                      key={v.key}
                      onPress={() => {
                        setView(v.key);
                        setViewMenuOpen(false);
                      }}
                      style={[styles.viewMenuItem, { borderColor: tokens.border }]}
                    >
                      <Text style={{ color: tokens.popoverForeground, fontSize: tokens.text.sm }}>{v.label}</Text>
                      {view === v.key ? <Ionicons name="checkmark" size={16} color={tokens.primary} /> : null}
                    </Pressable>
                  ))}
                </View>
              </>
            ) : null}
          </View>
        </View>

        {view === 'day' ? (
          <View style={[styles.dayCard, { backgroundColor: tokens.card, borderColor: tokens.border, borderRadius: tokens.radius.xl }]}>
            <DayAuditsList dateISO={CAL_TO_ISO(new Date(cal.year, cal.month, cal.day))} auditPool={auditPool} />
          </View>
        ) : (
          <>
            <View style={styles.weekdayRow}>
              {WEEKDAYS.map((w) => (
                <View key={w} style={[styles.weekdayBox, { backgroundColor: tokens.card, borderColor: tokens.border, borderRadius: tokens.radius.lg }]}>
                  <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm }}>{w}</Text>
                </View>
              ))}
            </View>

            {(view === 'week' ? weekOnly(cal) : monthWeeks(cal)).map((weekDates, i) => (
              <TabletWeekRow
                key={i}
                weekDates={weekDates}
                refMonth={view === 'week' ? null : cal.month}
                todayISO={todayISO}
                selectedDateISO={selectedDateISO}
                auditPool={auditPool}
                onDayPress={openDay}
              />
            ))}
          </>
        )}
      </ScrollView>

      <Modal visible={!!modalDateISO} transparent animationType="fade" onRequestClose={() => setModalDateISO(null)}>
        <Pressable style={[styles.modalBackdrop, { backgroundColor: tokens.scrim }]} onPress={() => setModalDateISO(null)}>
          <Pressable
            style={[styles.modalPanel, { backgroundColor: tokens.popover, borderRadius: tokens.radius.xl }]}
            onPress={(e) => e.stopPropagation()}
          >
            <View style={styles.modalHead}>
              <Text style={{ color: tokens.popoverForeground, fontWeight: tokens.fontWeight.extrabold, fontSize: tokens.text.base }}>
                Schedule Details
              </Text>
              <Pressable onPress={() => setModalDateISO(null)} hitSlop={8}>
                <Ionicons name="close" size={20} color={tokens.foreground} />
              </Pressable>
            </View>
            {modalDateISO ? (
              <>
                <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.sm, marginBottom: 14 }}>
                  {new Date(`${modalDateISO}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })}
                </Text>
                <ScrollView style={{ maxHeight: 420 }}>
                  <DayAuditsList dateISO={modalDateISO} auditPool={auditPool} />
                </ScrollView>
              </>
            ) : null}
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

function monthWeeks(cal: { year: number; month: number }): Date[][] {
  const firstOfMonth = new Date(cal.year, cal.month, 1);
  const startOffset = mondayIndex(firstOfMonth.getDay());
  const gridStart = new Date(cal.year, cal.month, 1 - startOffset);
  const lastOfMonth = new Date(cal.year, cal.month + 1, 0);
  const endOffset = 6 - mondayIndex(lastOfMonth.getDay());
  const gridEnd = new Date(cal.year, cal.month + 1, endOffset);
  const totalWeeks = Math.round((gridEnd.getTime() - gridStart.getTime()) / 86400000 + 1) / 7;
  return Array.from({ length: totalWeeks }, (_, w) =>
    Array.from({ length: 7 }, (_, i) => {
      const d = new Date(gridStart);
      d.setDate(gridStart.getDate() + w * 7 + i);
      return d;
    }),
  );
}

function weekOnly(cal: { year: number; month: number; day: number }): Date[][] {
  const anchor = new Date(cal.year, cal.month, cal.day);
  const weekStart = new Date(anchor);
  weekStart.setDate(anchor.getDate() - mondayIndex(anchor.getDay()));
  return [Array.from({ length: 7 }, (_, i) => { const d = new Date(weekStart); d.setDate(weekStart.getDate() + i); return d; })];
}

// One Mon-Sun row of bordered day boxes, with a lane-stacked events layer
// overlaid across the row (left/width percentages, same technique the
// phone's WeekRow uses) — so a multi-day bar visually crosses cell borders
// instead of being clipped per-cell. A bar's first day renders as a named
// chip (colored dot + audit name); the rest of its span renders as a plain
// colored continuation strip in the same lane.
function TabletWeekRow({
  weekDates,
  refMonth,
  todayISO,
  selectedDateISO,
  auditPool,
  onDayPress,
}: {
  weekDates: Date[];
  refMonth: number | null;
  todayISO: string;
  selectedDateISO: string | null;
  auditPool: Audit[];
  onDayPress: (iso: string) => void;
}) {
  const { tokens } = useTheme();
  const { hiddenByCol, laneRows } = buildWeekRowData(weekDates, auditPool);
  const typeColor = { spot: tokens.accentBlue, full: tokens.accentPurple, cycle: tokens.rag.amber };

  return (
    <View style={styles.weekWrap}>
      <View style={styles.dayRow}>
        {weekDates.map((d) => {
          const iso = CAL_TO_ISO(d);
          const inMonth = refMonth == null || d.getMonth() === refMonth;
          const isToday = iso === todayISO;
          const isSelected = iso === selectedDateISO;
          const isSunday = mondayIndex(d.getDay()) === 6;
          return (
            <Pressable
              key={iso}
              onPress={() => onDayPress(iso)}
              style={[
                styles.dayCell,
                {
                  backgroundColor: tokens.card,
                  borderColor: isSelected ? tokens.primary : tokens.border,
                  borderWidth: isSelected ? 2 : 1,
                  borderRadius: tokens.radius.lg,
                },
              ]}
            >
              <View
                style={[
                  styles.dayNumWrap,
                  isToday ? { borderWidth: 1.5, borderColor: tokens.primary, borderRadius: tokens.radius.sm } : null,
                ]}
              >
                <Text
                  style={{
                    color: !inMonth ? tokens.slate400 : isToday ? tokens.primary : isSunday ? tokens.rag.red.strong : tokens.foreground,
                    fontSize: tokens.text.sm,
                    fontWeight: tokens.fontWeight.bold,
                  }}
                >
                  {String(d.getDate()).padStart(2, '0')}
                </Text>
              </View>
            </Pressable>
          );
        })}
      </View>

      <View pointerEvents="box-none" style={styles.eventsLayer}>
        {laneRows.map((row, laneIdx) =>
          row.map((b) => {
            const c = typeColor[scheduleTypeKey(b.audit.audit_type)];
            const top = laneIdx * LANE_HEIGHT;
            return (
              <View
                key={`${b.audit.audit_id}-${b.colStart}`}
                style={[
                  styles.chip,
                  { top, left: `${(b.colStart / 7) * 100}%`, width: `${(b.colSpan / 7) * 100}%`, backgroundColor: c.soft, borderRadius: tokens.radius.sm },
                ]}
              >
                <Text numberOfLines={1} style={{ color: c.strong, fontSize: 10.5, fontWeight: tokens.fontWeight.bold }}>
                  {b.audit.audit_name}
                </Text>
              </View>
            );
          }),
        )}
        {hiddenByCol.map((n, i) =>
          n > 0 ? (
            <Text
              key={i}
              style={[
                styles.moreText,
                { top: laneRows.length * LANE_HEIGHT + 2, left: `${(i / 7) * 100}%`, width: `${(1 / 7) * 100}%`, color: tokens.mutedForeground },
              ]}
            >
              +{n} More
            </Text>
          ) : null,
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  body: { padding: 20, gap: 14 },
  toolbar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  navGroup: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  navBox: { height: 44, minWidth: 44, alignItems: 'center', justifyContent: 'center', borderWidth: 1, paddingHorizontal: 10 },
  labelBox: { height: 44, minWidth: 180, alignItems: 'center', justifyContent: 'center', borderWidth: 1, paddingHorizontal: 18 },
  viewSelectBox: { flexDirection: 'row', gap: 8, minWidth: 130, justifyContent: 'space-between' },
  viewMenu: { position: 'absolute', top: 48, right: 0, width: 150, borderWidth: 1, overflow: 'hidden', zIndex: 10 },
  viewMenuItem: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  weekdayRow: { flexDirection: 'row', gap: 8 },
  weekdayBox: { flex: 1, alignItems: 'center', justifyContent: 'center', height: 40, borderWidth: 1 },
  // Seamless table grid — cells share borders edge-to-edge (no gap, no
  // per-cell rounding), matching the reference's continuous grid look
  // rather than separated rounded cards. Rows also butt directly against
  // each other (marginTop: -1 collapses the shared border to one line).
  weekWrap: { position: 'relative', marginBottom: 8 },
  dayRow: { flexDirection: 'row', gap: 8 },
  dayCell: { flex: 1, minHeight: CELL_MIN_HEIGHT, borderWidth: 1, padding: 8, alignItems: 'flex-end' },
  dayNumWrap: { paddingHorizontal: 6, paddingVertical: 2, minWidth: 24, alignItems: 'center' },
  eventsLayer: { position: 'absolute', left: 8, right: 8, top: 34 },
  chip: { position: 'absolute', justifyContent: 'center', height: LANE_HEIGHT - 4, marginTop: 2, paddingHorizontal: 7, marginHorizontal: 3 },
  moreText: { position: 'absolute', fontSize: 10, fontWeight: '700' },
  dayCard: { borderWidth: 1, padding: 16 },
  modalBackdrop: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  modalPanel: { width: '100%', maxWidth: 460, padding: 20 },
  modalHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 },
});
