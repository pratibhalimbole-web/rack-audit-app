import { Ionicons } from '@expo/vector-icons';
import { useMemo, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { AppHeader } from '@/components/AppHeader';
import { Card } from '@/components/Card';
import { mine } from '@/lib/auditLogic';
import { useTheme } from '@/theme/ThemeProvider';
import { useAudits } from '../dashboard/hooks';
import { DayAuditsList } from './DayAuditsList';
import { CAL_TO_ISO, mondayIndex } from './scheduleLogic';
import { WeekRow } from './WeekRow';

type CalView = 'month' | 'week' | 'day';
const VIEWS: { key: CalView; label: string }[] = [
  { key: 'month', label: 'Monthly' },
  { key: 'week', label: 'Weekly' },
  { key: 'day', label: 'Daily' },
];
const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

// Ports renderSchedule() (rack-audit-app.html ~3311-3608): a Mon-Sun
// month/week calendar of this inspector's audits keyed off start_date, plus
// a Day view / day-tap modal listing that day's audits grouped by type.
export function ScheduleScreen() {
  const { tokens } = useTheme();
  const { data: audits = [] } = useAudits();
  const auditPool = useMemo(() => mine(audits), [audits]);

  const now = new Date();
  const [cal, setCal] = useState({ year: now.getFullYear(), month: now.getMonth(), day: now.getDate() });
  const [view, setView] = useState<CalView>('month');
  const [viewMenuOpen, setViewMenuOpen] = useState(false);
  const [modalDateISO, setModalDateISO] = useState<string | null>(null);
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

  const viewSelect = (
    <View>
      <Pressable onPress={() => setViewMenuOpen((o) => !o)} style={[styles.viewSelectBtn, { borderColor: tokens.border, borderRadius: tokens.radius.lg }]}>
        <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.semibold, fontSize: tokens.text.sm }}>
          {VIEWS.find((v) => v.key === view)!.label}
        </Text>
        <Ionicons name="chevron-down" size={14} color={tokens.mutedForeground} />
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
  );

  const legend = (
    <View style={styles.legendRow}>
      <LegendSwatch color={tokens.accentBlue.base} label="Spot Check" />
      <LegendSwatch color={tokens.accentPurple.base} label="Full" />
      <LegendSwatch color={tokens.rag.amber.base} label="Cycle Count" />
    </View>
  );

  let toolbarLabel = '';
  let body: React.ReactNode = null;

  if (view === 'week') {
    const anchor = new Date(cal.year, cal.month, cal.day);
    const weekStart = new Date(anchor);
    weekStart.setDate(anchor.getDate() - mondayIndex(anchor.getDay()));
    const weekDates = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(weekStart);
      d.setDate(weekStart.getDate() + i);
      return d;
    });
    toolbarLabel = `${weekDates[0].toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })} – ${weekDates[6].toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}`;
    body = (
      <>
        <View style={styles.weekdayRow}>
          {WEEKDAYS.map((w) => (
            <Text key={w} style={[styles.weekdayLabel, { color: tokens.mutedForeground }]} numberOfLines={1}>
              {w.slice(0, 3)}
            </Text>
          ))}
        </View>
        <WeekRow weekDates={weekDates} refMonth={null} todayISO={todayISO} auditPool={auditPool} onDayPress={setModalDateISO} />
        {legend}
      </>
    );
  } else if (view === 'day') {
    const anchor = new Date(cal.year, cal.month, cal.day);
    const dateISO = CAL_TO_ISO(anchor);
    toolbarLabel = anchor.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    body = (
      <Card>
        <DayAuditsList dateISO={dateISO} auditPool={auditPool} />
      </Card>
    );
  } else {
    const firstOfMonth = new Date(cal.year, cal.month, 1);
    const startOffset = mondayIndex(firstOfMonth.getDay());
    const gridStart = new Date(cal.year, cal.month, 1 - startOffset);
    const lastOfMonth = new Date(cal.year, cal.month + 1, 0);
    const endOffset = 6 - mondayIndex(lastOfMonth.getDay());
    const gridEnd = new Date(cal.year, cal.month + 1, endOffset);
    const totalWeeks = Math.round((gridEnd.getTime() - gridStart.getTime()) / 86400000 + 1) / 7;
    const weekRows = Array.from({ length: totalWeeks }, (_, w) =>
      Array.from({ length: 7 }, (_, i) => {
        const d = new Date(gridStart);
        d.setDate(gridStart.getDate() + w * 7 + i);
        return d;
      }),
    );
    toolbarLabel = firstOfMonth.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
    body = (
      <>
        <View style={styles.weekdayRow}>
          {WEEKDAYS.map((w) => (
            <Text key={w} style={[styles.weekdayLabel, { color: tokens.mutedForeground }]} numberOfLines={1}>
              {w.slice(0, 3)}
            </Text>
          ))}
        </View>
        {weekRows.map((weekDates, i) => (
          <WeekRow key={i} weekDates={weekDates} refMonth={cal.month} todayISO={todayISO} auditPool={auditPool} onDayPress={setModalDateISO} />
        ))}
        {legend}
      </>
    );
  }

  const shift = (delta: number) => (view === 'week' ? shiftWeek(delta) : view === 'day' ? shiftDay(delta) : shiftMonth(delta));

  return (
    <View style={{ flex: 1, backgroundColor: tokens.muted }}>
      <AppHeader title="Audit Schedule" showBack menuItems={[{ label: 'Sync Now', onPress: () => {} }]} />
      <ScrollView contentContainerStyle={styles.body}>
        <View style={styles.toolbar}>
          <View style={styles.navRow}>
            <Pressable onPress={() => shift(-1)} style={[styles.navBtn, { backgroundColor: tokens.muted, borderRadius: tokens.radius.lg }]}>
              <Ionicons name="chevron-back" size={16} color={tokens.foreground} />
            </Pressable>
            <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm }} numberOfLines={1}>
              {toolbarLabel}
            </Text>
            <Pressable onPress={() => shift(1)} style={[styles.navBtn, { backgroundColor: tokens.muted, borderRadius: tokens.radius.lg }]}>
              <Ionicons name="chevron-forward" size={16} color={tokens.foreground} />
            </Pressable>
          </View>
          {viewSelect}
        </View>
        {view === 'day' ? body : <Card style={{ padding: 12 }}>{body}</Card>}
      </ScrollView>

      <Modal visible={!!modalDateISO} transparent animationType="fade" onRequestClose={() => setModalDateISO(null)}>
        <Pressable style={[styles.modalBackdrop, { backgroundColor: 'rgba(0,0,0,0.5)' }]} onPress={() => setModalDateISO(null)}>
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
                <ScrollView style={{ maxHeight: 380 }}>
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

function LegendSwatch({ color, label }: { color: string; label: string }) {
  const { tokens } = useTheme();
  return (
    <View style={styles.legendItem}>
      <View style={[styles.legendDot, { backgroundColor: color }]} />
      <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xxs, fontWeight: tokens.fontWeight.semibold }}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  body: { padding: 16, gap: 14 },
  toolbar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  navRow: { flexDirection: 'row', alignItems: 'center', gap: 10, flex: 1, minWidth: 0 },
  navBtn: { width: 30, height: 30, alignItems: 'center', justifyContent: 'center' },
  viewSelectBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, borderWidth: 1, paddingHorizontal: 12, height: 34 },
  viewMenu: { position: 'absolute', top: 38, right: 0, width: 140, borderWidth: 1, overflow: 'hidden', zIndex: 10 },
  viewMenuItem: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  weekdayRow: { flexDirection: 'row', marginBottom: 6 },
  weekdayLabel: { flex: 1, textAlign: 'center', fontSize: 10, fontWeight: '700' },
  legendRow: { flexDirection: 'row', gap: 16, marginTop: 10, flexWrap: 'wrap' },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  legendDot: { width: 8, height: 8, borderRadius: 4 },
  modalBackdrop: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  modalPanel: { width: '100%', maxWidth: 420, padding: 18 },
  modalHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 },
});
