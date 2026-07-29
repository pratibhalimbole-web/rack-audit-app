import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { fmtDate, uiStatus } from '@/lib/auditLogic';
import { AUDIT_TYPE_ICON } from '@/lib/auditTypeIcon';
import type { Audit } from '@/lib/types';
import { useTheme } from '@/theme/ThemeProvider';
import { Pill } from './Pill';

// Ports taskCard() (rack-audit-app.html ~2003-2038) — phone variant stacks a
// name/chevron row above a due/status footer; tablet variant is one flat row
// with due date + status pill as direct siblings (source's own phone/tablet
// branch inside the same function).
export function TaskCard({ audit, variant = 'phone' }: { audit: Audit; variant?: 'phone' | 'tablet' }) {
  const { tokens } = useTheme();
  const uis = uiStatus(audit);
  const overdue = uis === 'Overdue';

  const icon = (
    <View style={[styles.iconWrap, { backgroundColor: tokens.muted, borderRadius: tokens.radius.lg }]}>
      <Ionicons name={AUDIT_TYPE_ICON[audit.audit_type]} size={16} color={tokens.mutedForeground} />
    </View>
  );

  const nameBlock = (
    <View style={styles.info}>
      <Text numberOfLines={1} style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm }}>
        {audit.audit_name}
      </Text>
      <Text numberOfLines={1} style={{ color: tokens.mutedForeground, fontSize: tokens.text.xs, marginTop: 2 }}>
        {audit.audit_id} · {audit.scope_values.join(', ')}
      </Text>
    </View>
  );

  const cardStyle = [
    styles.card,
    { backgroundColor: tokens.card, borderColor: overdue ? tokens.rag.red.border : tokens.border, borderRadius: tokens.radius.xl },
  ];

  const onPress = () => router.push({ pathname: '/audit/[auditId]', params: { auditId: audit.audit_id } } as never);

  if (variant === 'tablet') {
    return (
      <Pressable onPress={onPress} style={[...cardStyle, styles.tabletRow]}>
        {icon}
        {nameBlock}
        <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xs, marginRight: 10 }}>Due {fmtDate(audit.end_date)}</Text>
        <Pill label={uis} tone={uis} />
        <Ionicons name="chevron-forward" size={16} color={tokens.slate400} style={{ marginLeft: 8 }} />
      </Pressable>
    );
  }

  return (
    <Pressable onPress={onPress} style={cardStyle}>
      <View style={styles.row}>
        {icon}
        {nameBlock}
        <Ionicons name="chevron-forward" size={16} color={tokens.slate400} />
      </View>
      <View style={[styles.footer, { borderTopColor: tokens.border }]}>
        <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xs }}>Due {fmtDate(audit.end_date)}</Text>
        <Pill label={uis} tone={uis} />
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: 1, padding: 12, gap: 10 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  tabletRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  info: { flex: 1, minWidth: 0 },
  iconWrap: { width: 34, height: 34, alignItems: 'center', justifyContent: 'center' },
  footer: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: 10, borderTopWidth: StyleSheet.hairlineWidth },
});
