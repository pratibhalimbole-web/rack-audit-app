import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { Audit } from '@/lib/types';
import { useTheme } from '@/theme/ThemeProvider';
import { dayAuditGroups, scheduleTypeKey } from './scheduleLogic';

// Ports dayAuditsGroupsHtml() (rack-audit-app.html ~3446-3465) — shared by
// the Day view and the day-tap modal so a given day reads identically
// whichever way it's reached.
export function DayAuditsList({ dateISO, auditPool }: { dateISO: string; auditPool: Audit[] }) {
  const { tokens } = useTheme();
  const groups = dayAuditGroups(dateISO, auditPool);
  const typeColor = { spot: tokens.accentBlue, full: tokens.accentPurple, cycle: tokens.rag.amber };

  if (!groups.length) {
    return (
      <View style={styles.empty}>
        <Ionicons name="checkbox-outline" size={26} color="#667085" />
        <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.sm }}>No inspections scheduled for this day.</Text>
      </View>
    );
  }

  return (
    <View style={{ gap: 16 }}>
      {groups.map((g) => (
        <View key={g.type} style={{ gap: 8 }}>
          <Text style={{ color: tokens.mutedForeground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.xs }}>{g.type}</Text>
          {g.audits.map((a) => {
            const c = typeColor[scheduleTypeKey(a.audit_type)];
            return (
              <Pressable
                key={a.audit_id}
                onPress={() => router.push({ pathname: '/audit/[auditId]', params: { auditId: a.audit_id } } as never)}
                style={[styles.card, { backgroundColor: tokens.card, borderColor: tokens.border, borderLeftColor: c.base, borderRadius: tokens.radius.lg }]}
              >
                <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm }}>{a.audit_name}</Text>
                <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xs, marginTop: 2 }}>{a.scope_values.join(', ')}</Text>
                <View style={styles.metaRow}>
                  <Ionicons name="person-outline" size={12} color="#667085" />
                  <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xs }}>
                    {a.team_members.length} member{a.team_members.length === 1 ? '' : 's'}
                  </Text>
                </View>
              </Pressable>
            );
          })}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  empty: { alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 30 },
  card: { borderWidth: 1, borderLeftWidth: 4, padding: 12 },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 6 },
});
