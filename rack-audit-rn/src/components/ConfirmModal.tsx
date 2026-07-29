import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '@/theme/ThemeProvider';

// Ports renderConfirmModal() (rack-audit-app.html's generic OK/Cancel
// modal) — used wherever an action would silently discard something (an
// unsaved pallet count, a saved record, a scan line).
export function ConfirmModal({
  visible,
  message,
  onCancel,
  onConfirm,
}: {
  visible: boolean;
  message: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { tokens } = useTheme();
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <Pressable style={[styles.backdrop, { backgroundColor: tokens.scrim }]} onPress={onCancel}>
        <Pressable style={[styles.card, { backgroundColor: tokens.popover, borderRadius: tokens.radius.xl }]} onPress={(e) => e.stopPropagation()}>
          <Text style={{ color: tokens.popoverForeground, fontSize: tokens.text.base, lineHeight: 20 }}>{message}</Text>
          <View style={styles.actions}>
            <Pressable onPress={onCancel} style={[styles.btn, styles.outlineBtn, { borderColor: tokens.border, borderRadius: tokens.radius.lg }]}>
              <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.semibold, fontSize: tokens.text.sm }}>Cancel</Text>
            </Pressable>
            <Pressable onPress={onConfirm} style={[styles.btn, { backgroundColor: tokens.primary, borderRadius: tokens.radius.lg }]}>
              <Text style={{ color: tokens.primaryForeground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm }}>OK</Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  card: { width: '100%', maxWidth: 360, padding: 20 },
  actions: { flexDirection: 'row', gap: 10, marginTop: 20 },
  btn: { flex: 1, height: 44, alignItems: 'center', justifyContent: 'center' },
  outlineBtn: { borderWidth: 1 },
});
