import { Ionicons } from '@expo/vector-icons';
import { useMemo, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import type { LocationStatus } from '@/lib/types';
import { useTheme } from '@/theme/ThemeProvider';
import { Pill } from './Pill';

export type SheetOption = { value: string; label: string; status?: LocationStatus };

const STATUS_TONE = { 'Not Started': 'To Do', 'In Progress': 'In Progress', Completed: 'Completed' } as const;

// Ports the Layout/Rack/Bay/Storage-Location picker sheet (renderSheetOverlay
// + sheetListHtml + filterSheetList, rack-audit-app.html ~4342-4385). The
// source renders this as a bottom sheet on phone and an anchored dropdown on
// tablet; RN's <Modal> bottom-sheet presentation reads fine on both form
// factors here, so there's no separate tablet variant — reused as-is by
// Count Sheet and Rack View's Layout/Rack/Bay/Location fields.
export function BottomSheetPicker({
  visible,
  title,
  options,
  selectedValue,
  onSelect,
  onClose,
}: {
  visible: boolean;
  title: string;
  options: SheetOption[];
  selectedValue?: string | null;
  onSelect: (value: string) => void;
  onClose: () => void;
}) {
  const { tokens } = useTheme();
  const [search, setSearch] = useState('');

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q ? options.filter((o) => o.label.toLowerCase().includes(q)) : options;
  }, [options, search]);

  const handleClose = () => {
    setSearch('');
    onClose();
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={handleClose}>
      <Pressable style={[styles.backdrop, { backgroundColor: tokens.scrim }]} onPress={handleClose}>
        <Pressable
          style={[styles.panel, { backgroundColor: tokens.popover, borderTopLeftRadius: tokens.radius.xxl, borderTopRightRadius: tokens.radius.xxl }]}
          onPress={(e) => e.stopPropagation()}
        >
          <View style={[styles.handle, { backgroundColor: tokens.border }]} />
          <View style={styles.header}>
            <Text style={{ color: tokens.popoverForeground, fontWeight: tokens.fontWeight.extrabold, fontSize: tokens.text.base }}>{title}</Text>
            <Pressable
              onPress={handleClose}
              hitSlop={8}
              style={[styles.closeBtn, { backgroundColor: tokens.secondary, borderRadius: tokens.radius.lg }]}
            >
              <Ionicons name="close" size={18} color={tokens.foreground} />
            </Pressable>
          </View>
          {options.length > 6 ? (
            <View style={[styles.searchBox, { backgroundColor: tokens.muted, borderColor: tokens.border, borderRadius: tokens.radius.lg }]}>
              <Ionicons name="search" size={16} color={tokens.mutedForeground} />
              <TextInput
                value={search}
                onChangeText={setSearch}
                placeholder="Search..."
                placeholderTextColor={tokens.slate400}
                style={{ flex: 1, color: tokens.foreground, fontSize: tokens.text.sm, paddingVertical: 10 }}
              />
            </View>
          ) : null}
          <ScrollView style={styles.list}>
            {filtered.length ? (
              filtered.map((o) => {
                const selected = o.value === selectedValue;
                return (
                  <Pressable
                    key={o.value}
                    onPress={() => onSelect(o.value)}
                    style={[styles.item, { borderBottomColor: tokens.border }, selected ? { backgroundColor: tokens.muted } : null]}
                  >
                    <Text style={{ color: tokens.popoverForeground, fontSize: tokens.text.sm, flexShrink: 1 }}>{o.label}</Text>
                    <View style={styles.itemRight}>
                      {o.status ? <Pill label={o.status} tone={STATUS_TONE[o.status]} /> : null}
                      {selected ? <Ionicons name="checkmark" size={18} color={tokens.primary} /> : null}
                    </View>
                  </Pressable>
                );
              })
            ) : (
              <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.sm, textAlign: 'center', padding: 20 }}>No matches</Text>
            )}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end' },
  panel: { maxHeight: '75%', paddingHorizontal: 16, paddingTop: 10, paddingBottom: 24 },
  handle: { width: 40, height: 4, borderRadius: 2, alignSelf: 'center', marginBottom: 12 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
  closeBtn: { width: 30, height: 30, alignItems: 'center', justifyContent: 'center' },
  searchBox: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, paddingHorizontal: 12, marginBottom: 8 },
  list: { flexGrow: 0 },
  item: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 13, borderBottomWidth: StyleSheet.hairlineWidth, gap: 10 },
  itemRight: { flexDirection: 'row', alignItems: 'center', gap: 8 },
});
