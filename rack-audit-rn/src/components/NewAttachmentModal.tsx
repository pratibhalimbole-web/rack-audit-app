import { Ionicons } from '@expo/vector-icons';
import { useEffect, useState } from 'react';
import { LayoutChangeEvent, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { ANNOTATION_COLORS } from '@/lib/mockData';
import type { EvidenceImage, EvidenceStroke } from '@/lib/types';
import { useTheme } from '@/theme/ThemeProvider';
import { AnnotationCanvas } from './AnnotationCanvas';

const CANVAS_HEIGHT = 220;

// Ports renderImageAttachmentModal + setupImageAnnotationCanvas (source
// ~3024-3148): mark up a placeholder photo with colored freehand strokes
// before saving it onto a SKU line's evidence.images. There's no real camera
// capture wired up here (same honest-stub reasoning the source gives for
// this evidence flow) — what's real is the annotation itself.
export function NewAttachmentModal({ visible, onClose, onSave }: { visible: boolean; onClose: () => void; onSave: (image: EvidenceImage) => void }) {
  const { tokens } = useTheme();
  const [color, setColor] = useState(ANNOTATION_COLORS[0]);
  const [drawMode, setDrawMode] = useState(true);
  const [strokes, setStrokes] = useState<EvidenceStroke[]>([]);
  const [redoStack, setRedoStack] = useState<EvidenceStroke[]>([]);
  const [canvasWidth, setCanvasWidth] = useState(0);

  useEffect(() => {
    if (visible) {
      setStrokes([]);
      setRedoStack([]);
      setColor(ANNOTATION_COLORS[0]);
      setDrawMode(true);
    }
  }, [visible]);

  const handleStrokeComplete = (stroke: EvidenceStroke) => {
    setStrokes((prev) => [...prev, stroke]);
    setRedoStack([]);
  };
  const undo = () => {
    setStrokes((prev) => {
      if (!prev.length) return prev;
      setRedoStack((r) => [...r, prev[prev.length - 1]]);
      return prev.slice(0, -1);
    });
  };
  const redo = () => {
    setRedoStack((prev) => {
      if (!prev.length) return prev;
      setStrokes((s) => [...s, prev[prev.length - 1]]);
      return prev.slice(0, -1);
    });
  };
  const reset = () => {
    setStrokes([]);
    setRedoStack([]);
  };
  const handleSave = () => {
    onSave({ strokes });
    onClose();
  };
  const handlePhotoLayout = (e: LayoutChangeEvent) => setCanvasWidth(e.nativeEvent.layout.width);

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={[styles.backdrop, { backgroundColor: tokens.scrim }]} onPress={onClose}>
        <Pressable style={[styles.card, { backgroundColor: tokens.popover, borderRadius: tokens.radius.xl }]} onPress={(e) => e.stopPropagation()}>
          <ScrollView showsVerticalScrollIndicator={false}>
            <View style={styles.headRow}>
              <Text style={{ color: tokens.popoverForeground, fontWeight: tokens.fontWeight.extrabold, fontSize: tokens.text.base }}>
                New Attachment
              </Text>
              <Pressable onPress={onClose} hitSlop={8}>
                <Ionicons name="close" size={22} color={tokens.foreground} />
              </Pressable>
            </View>
            <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xs, marginBottom: 12 }}>
              Attach or click only four images related to any issues
            </Text>

            <View
              onLayout={handlePhotoLayout}
              style={[styles.photoWrap, { backgroundColor: tokens.muted, borderRadius: tokens.radius.lg }]}
            >
              <View style={[StyleSheet.absoluteFill, styles.photoPlaceholder]}>
                <Ionicons name="image-outline" size={40} color={tokens.slate400} />
              </View>
              {canvasWidth > 0 ? (
                <View style={StyleSheet.absoluteFill}>
                  <AnnotationCanvas
                    width={canvasWidth}
                    height={CANVAS_HEIGHT}
                    strokes={strokes}
                    color={color}
                    drawMode={drawMode}
                    onStrokeComplete={handleStrokeComplete}
                  />
                </View>
              ) : null}
            </View>

            <View style={styles.toolRow}>
              <View style={styles.colorRow}>
                {ANNOTATION_COLORS.map((c) => (
                  <Pressable key={c} onPress={() => setColor(c)} style={[styles.swatch, { backgroundColor: c }]}>
                    {color === c ? <Ionicons name="checkmark" size={14} color="#fff" /> : null}
                  </Pressable>
                ))}
              </View>
              <View style={styles.toolBtns}>
                <ToolButton icon="pencil" active={drawMode} onPress={() => setDrawMode((d) => !d)} label="Draw" />
                <ToolButton icon="arrow-redo-outline" onPress={redo} label="Redo" />
                <ToolButton icon="arrow-undo-outline" onPress={undo} label="Undo" />
              </View>
            </View>

            <View style={styles.footerRow}>
              <Pressable onPress={reset} style={[styles.dangerBtn, { borderColor: tokens.rag.red.border, borderRadius: tokens.radius.lg }]}>
                <Ionicons name="trash-outline" size={18} color={tokens.rag.red.strong} />
              </Pressable>
              <Pressable onPress={handleSave} style={[styles.saveBtn, { backgroundColor: tokens.primary, borderRadius: tokens.radius.lg }]}>
                <Text style={{ color: tokens.primaryForeground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm }}>Save Image</Text>
              </Pressable>
            </View>
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function ToolButton({ icon, active, onPress, label }: { icon: keyof typeof Ionicons.glyphMap; active?: boolean; onPress: () => void; label: string }) {
  const { tokens } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityLabel={label}
      style={[styles.toolBtn, { borderColor: tokens.border, borderRadius: tokens.radius.lg }, active ? { backgroundColor: tokens.accentBlue.soft, borderColor: tokens.primary } : null]}
    >
      <Ionicons name={icon} size={18} color={active ? tokens.primary : tokens.foreground} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 20 },
  card: { width: '100%', maxWidth: 480, maxHeight: '85%', padding: 18 },
  headRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 },
  photoWrap: { width: '100%', aspectRatio: 2.2, overflow: 'hidden', position: 'relative' },
  photoPlaceholder: { alignItems: 'center', justifyContent: 'center' },
  toolRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 14, gap: 10 },
  colorRow: { flexDirection: 'row', gap: 8, flexWrap: 'wrap', flex: 1 },
  swatch: { width: 26, height: 26, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
  toolBtns: { flexDirection: 'row', gap: 8 },
  toolBtn: { width: 38, height: 38, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  footerRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 18 },
  dangerBtn: { width: 44, height: 44, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  saveBtn: { flex: 1, height: 44, alignItems: 'center', justifyContent: 'center' },
});
