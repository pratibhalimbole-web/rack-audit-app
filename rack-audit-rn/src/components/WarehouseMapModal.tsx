import { Ionicons } from '@expo/vector-icons';
import { useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { WAREHOUSE_ZONES } from '@/lib/mockData';
import { useTheme } from '@/theme/ThemeProvider';

function zoneLabel(zone: string): string {
  return zone.replace('Layout', 'Zone');
}

// A schematic warehouse floor plan an inspector taps to pin exactly where a
// floor-stored SKU was actually found, when its scanned zone doesn't match
// what the WMS expected. Zones reuse the same Layout names used elsewhere
// (Quick Scan's "Zone Mismatch" flow), just relabeled "Zone" here to match
// how inspectors talk about floor storage.
export function WarehouseMapModal({
  visible,
  skuLabel,
  expectedZone,
  onConfirm,
  onClose,
}: {
  visible: boolean;
  skuLabel: string;
  expectedZone: string;
  onConfirm: (zone: string) => void;
  onClose: () => void;
}) {
  const { tokens } = useTheme();
  const [selected, setSelected] = useState<string | null>(null);

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={[styles.backdrop, { backgroundColor: 'rgba(0,0,0,0.45)' }]}>
        <View style={[styles.sheet, { backgroundColor: tokens.card, borderTopLeftRadius: tokens.radius.xxl, borderTopRightRadius: tokens.radius.xxl }]}>
          <View style={styles.headerRow}>
            <View style={{ flex: 1 }}>
              <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.extrabold, fontSize: tokens.text.base }}>Pin Exact Location</Text>
              <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xs, marginTop: 2 }} numberOfLines={1}>
                {skuLabel}
              </Text>
            </View>
            <Pressable onPress={onClose} hitSlop={10}>
              <Ionicons name="close" size={24} color={tokens.mutedForeground} />
            </Pressable>
          </View>

          <ScrollView contentContainerStyle={styles.body}>
            <View style={[styles.floorPlan, { backgroundColor: tokens.muted, borderColor: tokens.border, borderRadius: tokens.radius.lg }]}>
              <View style={styles.floorPlanLabelRow}>
                <Ionicons name="business-outline" size={14} color={tokens.mutedForeground} />
                <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xxs, fontWeight: tokens.fontWeight.semibold }}>WAREHOUSE FLOOR PLAN</Text>
              </View>

              <View style={styles.zoneGrid}>
                {WAREHOUSE_ZONES.map((zone) => {
                  const isSelected = selected === zone;
                  const isExpected = zone === expectedZone;
                  return (
                    <Pressable
                      key={zone}
                      onPress={() => setSelected(zone)}
                      style={[
                        styles.zoneTile,
                        {
                          backgroundColor: isSelected ? tokens.accentBlue.soft : tokens.card,
                          borderColor: isSelected ? tokens.primary : tokens.border,
                          borderWidth: isSelected ? 2 : 1,
                          borderRadius: tokens.radius.lg,
                        },
                      ]}
                    >
                      {isSelected ? (
                        <View style={[styles.checkBadge, { backgroundColor: tokens.primary }]}>
                          <Ionicons name="checkmark" size={12} color={tokens.primaryForeground} />
                        </View>
                      ) : null}
                      <View style={styles.rackLines}>
                        <View style={[styles.rackLine, { backgroundColor: tokens.border }]} />
                        <View style={[styles.rackLine, { backgroundColor: tokens.border }]} />
                        <View style={[styles.rackLine, { backgroundColor: tokens.border }]} />
                      </View>
                      <Text style={{ color: isSelected ? tokens.primary : tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm }}>
                        {zoneLabel(zone)}
                      </Text>
                      {isExpected ? (
                        <View style={[styles.expectedPill, { borderColor: tokens.accentBlue.border, backgroundColor: tokens.accentBlue.soft }]}>
                          <Text style={{ color: tokens.accentBlue.strong, fontSize: tokens.text.xxs, fontWeight: tokens.fontWeight.semibold }}>Expected</Text>
                        </View>
                      ) : null}
                    </Pressable>
                  );
                })}
              </View>

              <View style={[styles.dockBar, { borderColor: tokens.border }]}>
                <Ionicons name="cube-outline" size={14} color={tokens.mutedForeground} />
                <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xxs, fontWeight: tokens.fontWeight.semibold }}>LOADING DOCK</Text>
              </View>
            </View>

            <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.sm, marginTop: 14, textAlign: 'center' }}>
              Tap the zone where you actually found this item.
            </Text>
          </ScrollView>

          <View style={[styles.footer, { borderTopColor: tokens.border }]}>
            <Pressable
              disabled={!selected}
              onPress={() => selected && onConfirm(selected)}
              style={[
                styles.confirmBtn,
                { backgroundColor: selected ? tokens.primary : tokens.muted, borderRadius: tokens.radius.xxl },
              ]}
            >
              <Text style={{ color: selected ? tokens.primaryForeground : tokens.mutedForeground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm }}>
                Confirm & Raise Issue
              </Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end' },
  sheet: { maxHeight: '85%' },
  headerRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, padding: 16, paddingBottom: 8 },
  body: { paddingHorizontal: 16, paddingBottom: 16 },
  floorPlan: { borderWidth: 1, padding: 14, gap: 12 },
  floorPlanLabelRow: { flexDirection: 'row', alignItems: 'center', gap: 6, justifyContent: 'center' },
  zoneGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, justifyContent: 'center' },
  zoneTile: {
    width: '30%',
    minWidth: 96,
    aspectRatio: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    padding: 8,
  },
  checkBadge: { position: 'absolute', top: 6, right: 6, width: 18, height: 18, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  rackLines: { gap: 3, width: '60%' },
  rackLine: { height: 2, borderRadius: 1 },
  expectedPill: { borderWidth: 1, borderRadius: 6, paddingHorizontal: 6, paddingVertical: 1, marginTop: 2 },
  dockBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, borderWidth: StyleSheet.hairlineWidth, borderRadius: 6, paddingVertical: 6 },
  footer: { borderTopWidth: StyleSheet.hairlineWidth, padding: 16 },
  confirmBtn: { height: 50, alignItems: 'center', justifyContent: 'center' },
});
