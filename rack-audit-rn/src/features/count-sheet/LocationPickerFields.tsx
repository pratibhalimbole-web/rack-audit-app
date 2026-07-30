import { Ionicons } from '@expo/vector-icons';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { BottomSheetPicker, type SheetOption } from '@/components/BottomSheetPicker';
import { Pill } from '@/components/Pill';
import type { AuditLocationsTree } from '@/lib/types';
import { useTheme } from '@/theme/ThemeProvider';
import { applyFieldChange, locContext, type LocField, type LocSelect } from './locationSelectLogic';

const FIELD_TITLE: Record<LocField, string> = { layout: 'Select Layout', rack: 'Select Rack', bay: 'Select Bay', loc: 'Select Storage Location' };

// Ports computeLocationFieldParts/pickerRow/fixedFieldRow + openLocationSheet
// (rack-audit-app.html ~2137-2263): Layout/Rack/Bay/Storage Location, each
// either a muted "fixed" box (exactly one option — nothing to choose) or a
// button opening the shared BottomSheetPicker.
export function LocationPickerFields({
  tree,
  sel,
  onChange,
}: {
  tree: AuditLocationsTree;
  sel: LocSelect;
  onChange: (next: LocSelect) => void;
}) {
  const [openField, setOpenField] = useState<LocField | null>(null);
  const { layouts, layoutObj, racks, rackObj, bayObj } = locContext(tree, sel);

  const optionsFor = (field: LocField): SheetOption[] => {
    if (field === 'layout') return layouts.map((l) => ({ value: l.name, label: l.name }));
    if (field === 'rack') return racks.map((r) => ({ value: r.code, label: `Rack ${r.code}` }));
    if (field === 'bay') return rackObj ? rackObj.bays.map((b) => ({ value: b.code, label: `Bay ${b.code}` })) : [];
    return bayObj ? bayObj.locations.map((l) => ({ value: l.code, label: l.code, status: l.status })) : [];
  };

  const handleSelect = (field: LocField, value: string) => {
    onChange(applyFieldChange(tree, sel, field, value));
    setOpenField(null);
  };

  const locStatus = bayObj?.locations.find((l) => l.code === sel.loc)?.status;

  return (
    <View style={{ gap: 12 }}>
      <FieldRow label="Layout" value={sel.layout} fixed={layouts.length === 1} onPress={() => setOpenField('layout')} />
      <FieldRow
        label="Rack"
        value={sel.rack ? `Rack ${sel.rack}` : null}
        fixed={racks.length === 1}
        disabled={!layoutObj}
        onPress={() => setOpenField('rack')}
      />
      <FieldRow
        label="Bay"
        value={sel.bay ? `Bay ${sel.bay}` : null}
        fixed={!!rackObj && rackObj.bays.length === 1}
        disabled={!rackObj}
        onPress={() => setOpenField('bay')}
      />
      <FieldRow
        label="Storage Location"
        value={sel.loc}
        fixed={!!bayObj && bayObj.locations.length === 1}
        disabled={!bayObj}
        tag={locStatus}
        onPress={() => setOpenField('loc')}
      />

      {openField ? (
        <BottomSheetPicker
          visible
          title={FIELD_TITLE[openField]}
          options={optionsFor(openField)}
          selectedValue={sel[openField] ?? undefined}
          onSelect={(v) => handleSelect(openField, v)}
          onClose={() => setOpenField(null)}
        />
      ) : null}
    </View>
  );
}

function FieldRow({
  label,
  value,
  fixed,
  disabled,
  tag,
  onPress,
}: {
  label: string;
  value: string | null;
  fixed: boolean;
  disabled?: boolean;
  tag?: string;
  onPress: () => void;
}) {
  const { tokens } = useTheme();
  if (disabled) return null;

  return (
    <View>
      <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xs, marginBottom: 6 }}>{label}</Text>
      {fixed ? (
        <View style={[styles.fieldBtn, styles.fixed, { backgroundColor: tokens.muted, borderColor: tokens.border, borderRadius: tokens.radius.lg }]}>
          <Text style={{ color: tokens.foreground, fontSize: tokens.text.sm }}>{value}</Text>
        </View>
      ) : (
        <Pressable
          onPress={onPress}
          style={[styles.fieldBtn, { backgroundColor: tokens.card, borderColor: tokens.border, borderRadius: tokens.radius.lg }]}
        >
          <Text style={{ color: value ? tokens.foreground : tokens.mutedForeground, fontSize: tokens.text.sm }}>{value ?? `Select ${label}`}</Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            {tag ? <Pill label={tag} tone={tag === 'Not Started' ? 'To Do' : tag === 'In Progress' ? 'In Progress' : 'Completed'} /> : null}
            <Ionicons name="chevron-down" size={16} color="#667085" />
          </View>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  fieldBtn: { height: 46, borderWidth: 1, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  fixed: {},
});
