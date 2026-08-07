import { Ionicons } from '@expo/vector-icons';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { conditionSeverity } from '@/lib/conditionSeverity';
import { CONDITIONS, type CountLine, type Condition } from '@/lib/types';
import { useTheme } from '@/theme/ThemeProvider';

// Ports skuEditCardBody + the collapsed .sku-row-card (rack-audit-app.html
// ~2747-2818) — one card component covers both states since only one line
// is ever expanded at a time in renderScanLinesAccordion.
export function SkuLineCard({
  line,
  active,
  disabled,
  onQtyChange,
  onConditionChange,
  onSave,
  onDelete,
  onEdit,
  evidenceSlot,
  conditionLabel = 'Condition',
  conditionOptions = CONDITIONS,
  saveLabel = 'Save',
  hideDelete,
}: {
  line: CountLine;
  active: boolean;
  disabled?: boolean;
  onQtyChange: (qty: number) => void;
  onConditionChange: (condition: Condition) => void;
  onSave: () => void;
  onDelete: () => void;
  onEdit: () => void;
  // Rack View's SKU panel passes an EvidenceBlock here (source: withEvidence
  // on renderScanLinesAccordion); Count Sheet's own accordion never does.
  evidenceSlot?: React.ReactNode;
  // Rack View's Reconciliation Form calls this field "Damage" and drops the
  // redundant "Damaged" choice from the picklist; Count Sheet leaves both
  // defaults (label "Condition", full CONDITIONS list) untouched.
  conditionLabel?: string;
  conditionOptions?: Condition[];
  // Manual Mode's report form has nothing pre-existing to delete and calls
  // its primary action "Raise Issue" rather than "Save" — both default to
  // Count Sheet/Rack View's existing look.
  saveLabel?: string;
  hideDelete?: boolean;
}) {
  const { tokens } = useTheme();

  if (!active) {
    const sev = conditionSeverity(line.condition);
    const sevColors = tokens.rag[sev];
    return (
      <View style={[styles.collapsedCard, { backgroundColor: tokens.card, borderColor: tokens.border, borderRadius: tokens.radius.lg }]}>
        <Col label="SKU">
          <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm }}>{line.sku}</Text>
        </Col>
        <Col label="Quantity">
          <Text style={{ color: tokens.foreground, fontSize: tokens.text.sm }}>{line.qty}</Text>
        </Col>
        <Col label="Condition">
          <View style={[styles.sevPill, { backgroundColor: sevColors.soft, borderRadius: tokens.radius.sm }]}>
            <Text style={{ color: sevColors.strong, fontSize: tokens.text.xxs, fontWeight: tokens.fontWeight.semibold }}>{line.condition}</Text>
          </View>
        </Col>
        <Col label="Action">
          <View style={{ flexDirection: 'row', gap: 12 }}>
            <Pressable onPress={onEdit} hitSlop={8}>
              <Ionicons name="pencil" size={16} color="#667085" />
            </Pressable>
            <Pressable onPress={onDelete} hitSlop={8}>
              <Ionicons name="trash-outline" size={16} color={tokens.rag.red.strong} />
            </Pressable>
          </View>
        </Col>
      </View>
    );
  }

  return (
    <View style={[styles.activeCard, { backgroundColor: tokens.card, borderColor: tokens.primary, borderRadius: tokens.radius.lg }]}>
      <View style={styles.headRow}>
        <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.extrabold, fontSize: tokens.text.sm }}>{line.sku}</Text>
        <View style={[styles.lotBadge, { backgroundColor: tokens.muted, borderRadius: tokens.radius.sm }]}>
          <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xxs, fontWeight: tokens.fontWeight.semibold }}>LOT {line.lot}</Text>
        </View>
      </View>

      <Text style={[styles.sectionLabel, { color: tokens.foreground }]}>
        Quantity <Text style={{ color: tokens.rag.red.strong }}>*</Text>
      </Text>
      <TextInput
        value={String(line.qty)}
        editable={!disabled}
        keyboardType="number-pad"
        onChangeText={(v) => {
          const n = parseInt(v, 10);
          onQtyChange(Number.isNaN(n) ? 0 : Math.max(0, n));
        }}
        style={[styles.qtyInput, { color: tokens.foreground, borderColor: tokens.border, borderRadius: tokens.radius.lg, backgroundColor: tokens.inputBackground }]}
      />

      <Text style={[styles.sectionLabel, { color: tokens.foreground }]}>
        {conditionLabel} <Text style={{ color: tokens.rag.red.strong }}>*</Text>
      </Text>
      <View style={styles.condGrid}>
        {conditionOptions.map((c) => {
          const selected = line.condition === c;
          return (
            <Pressable
              key={c}
              disabled={disabled}
              onPress={() => onConditionChange(c)}
              style={[
                styles.condChip,
                { borderColor: selected ? tokens.primary : tokens.border, backgroundColor: selected ? tokens.accentBlue.soft : tokens.card, borderRadius: tokens.radius.lg },
              ]}
            >
              <View style={[styles.radioDot, { borderColor: selected ? tokens.primary : tokens.slate400 }]}>
                {selected ? <View style={[styles.radioDotFill, { backgroundColor: tokens.primary }]} /> : null}
              </View>
              <Text style={{ color: tokens.foreground, fontSize: tokens.text.xs }}>{c}</Text>
            </Pressable>
          );
        })}
      </View>

      {evidenceSlot}

      {!disabled ? (
        <View style={styles.footerRow}>
          <Pressable onPress={onSave} style={[styles.saveBtn, { backgroundColor: tokens.primary, borderRadius: tokens.radius.lg }]}>
            <Text style={{ color: tokens.primaryForeground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm }}>{saveLabel}</Text>
          </Pressable>
          {!hideDelete ? (
            <Pressable onPress={onDelete} style={[styles.deleteBtn, { borderColor: tokens.rag.red.border, borderRadius: tokens.radius.lg }]}>
              <Ionicons name="trash-outline" size={18} color={tokens.rag.red.strong} />
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

function Col({ label, children }: { label: string; children: React.ReactNode }) {
  const { tokens } = useTheme();
  return (
    <View style={styles.col}>
      <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xxs, marginBottom: 4 }}>{label}</Text>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  collapsedCard: { flexDirection: 'row', flexWrap: 'wrap', borderWidth: 1, padding: 12, gap: 10 },
  col: { minWidth: 64, flexGrow: 1 },
  sevPill: { alignSelf: 'flex-start', paddingHorizontal: 8, paddingVertical: 2 },
  activeCard: { borderWidth: 1.5, padding: 14 },
  headRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
  lotBadge: { flexDirection: 'row', paddingHorizontal: 8, paddingVertical: 3 },
  sectionLabel: { fontSize: 12, fontWeight: '700', marginBottom: 8, marginTop: 4 },
  qtyInput: { height: 44, borderWidth: 1, paddingHorizontal: 12, fontSize: 14, marginBottom: 10 },
  condGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 4 },
  condChip: { flexDirection: 'row', alignItems: 'center', gap: 6, borderWidth: 1, paddingHorizontal: 10, paddingVertical: 8 },
  radioDot: { width: 14, height: 14, borderRadius: 7, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center' },
  radioDotFill: { width: 7, height: 7, borderRadius: 3.5 },
  footerRow: { flexDirection: 'row', gap: 10, marginTop: 12 },
  saveBtn: { flex: 1, height: 40, alignItems: 'center', justifyContent: 'center' },
  deleteBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center', borderWidth: 1 },
});
