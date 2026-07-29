import { Ionicons } from '@expo/vector-icons';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import type { Evidence } from '@/lib/types';
import { useTheme } from '@/theme/ThemeProvider';

// Ports renderEvidenceBlock/ensureEvidence (rack-audit-app.html ~3150-3191)
// — note/audio/photo/video capture on a scanned SKU line, shown only in
// Rack View's SKU panel (source: withEvidence, Count Sheet's own accordion
// never passes it). No real mic/camera capture is wired for audio/video
// (same "honest stub" reasoning the source gives) — the photo path is real
// (AnnotationCanvas), audio/video stay mocked waveform/duration stubs.
export function EvidenceBlock({
  evidence,
  onOpenNote,
  onChangeNote,
  onRecordAudio,
  onToggleAudioPlay,
  onRemoveAudio,
  onAddImage,
  onRemoveImage,
  onAddVideo,
  onRemoveVideo,
}: {
  evidence: Evidence;
  onOpenNote: () => void;
  onChangeNote: (note: string) => void;
  onRecordAudio: () => void;
  onToggleAudioPlay: () => void;
  onRemoveAudio: () => void;
  onAddImage: () => void;
  onRemoveImage: (i: number) => void;
  onAddVideo: () => void;
  onRemoveVideo: (i: number) => void;
}) {
  const { tokens } = useTheme();

  return (
    <View style={[styles.wrap, { borderTopColor: tokens.border }]}>
      <View style={styles.row}>
        <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xs, flex: 1 }}>Write a note or record an audio for the issue</Text>
        <View style={styles.btnRow}>
          <IconBtn icon="pencil-outline" onPress={onOpenNote} label="Add note" />
          <IconBtn icon="mic-outline" onPress={onRecordAudio} label="Record audio" />
        </View>
      </View>

      {evidence.noteOpen || evidence.note ? (
        <TextInput
          value={evidence.note}
          onChangeText={onChangeNote}
          placeholder="Add a note..."
          placeholderTextColor={tokens.slate400}
          multiline
          style={[styles.noteInput, { color: tokens.foreground, borderColor: tokens.border, borderRadius: tokens.radius.lg, backgroundColor: tokens.inputBackground }]}
        />
      ) : null}

      {evidence.audio ? (
        <View style={[styles.audioRow, { backgroundColor: tokens.muted, borderRadius: tokens.radius.lg }]}>
          <Pressable onPress={onToggleAudioPlay} hitSlop={6}>
            <Ionicons name={evidence.audio.playing ? 'pause' : 'play'} size={16} color={tokens.foreground} />
          </Pressable>
          <View style={styles.waveform}>
            {evidence.audio.bars.map((h, i) => (
              <View key={i} style={[styles.waveBar, { height: h, backgroundColor: tokens.mutedForeground }]} />
            ))}
          </View>
          <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xs }}>{evidence.audio.durationSec}s</Text>
          <Pressable onPress={onRemoveAudio} hitSlop={6}>
            <Ionicons name="trash-outline" size={16} color={tokens.rag.red.strong} />
          </Pressable>
        </View>
      ) : null}

      <View style={styles.row}>
        <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xs, flex: 1 }}>Click on upload image or capture video for the issue</Text>
        <View style={styles.btnRow}>
          <IconBtn icon="camera-outline" onPress={onAddImage} label="Add photo" />
          <IconBtn icon="videocam-outline" onPress={onAddVideo} label="Add video" />
        </View>
      </View>

      {evidence.images.length ? (
        <ThumbGroup icon="image-outline" label="Image Attachments" count={evidence.images.length}>
          {evidence.images.map((_, i) => (
            <Pressable key={i} onPress={() => onRemoveImage(i)} style={[styles.thumb, { backgroundColor: tokens.muted, borderRadius: tokens.radius.lg }]}>
              <Ionicons name="image-outline" size={18} color={tokens.mutedForeground} />
            </Pressable>
          ))}
        </ThumbGroup>
      ) : null}

      {evidence.videos.length ? (
        <ThumbGroup icon="videocam-outline" label="Video Attachments" count={evidence.videos.length}>
          {evidence.videos.map((v, i) => (
            <Pressable key={i} onPress={() => onRemoveVideo(i)} style={[styles.thumb, { backgroundColor: tokens.muted, borderRadius: tokens.radius.lg }]}>
              <Text style={{ color: tokens.mutedForeground, fontSize: 9 }}>00:{v.durationSec}s</Text>
              <Ionicons name="play" size={14} color={tokens.mutedForeground} />
            </Pressable>
          ))}
        </ThumbGroup>
      ) : null}
    </View>
  );
}

function IconBtn({ icon, onPress, label }: { icon: keyof typeof Ionicons.glyphMap; onPress: () => void; label: string }) {
  const { tokens } = useTheme();
  return (
    <Pressable onPress={onPress} accessibilityLabel={label} style={[styles.iconBtn, { backgroundColor: tokens.muted, borderRadius: tokens.radius.lg }]}>
      <Ionicons name={icon} size={16} color={tokens.foreground} />
    </Pressable>
  );
}

function ThumbGroup({ icon, label, count, children }: { icon: keyof typeof Ionicons.glyphMap; label: string; count: number; children: React.ReactNode }) {
  const { tokens } = useTheme();
  return (
    <View style={{ marginTop: 4 }}>
      <View style={styles.groupHeadRow}>
        <Ionicons name={icon} size={14} color={tokens.mutedForeground} />
        <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.xs, fontWeight: tokens.fontWeight.semibold }}>{label}</Text>
        <View style={[styles.countBadge, { backgroundColor: tokens.accentBlue.soft, borderRadius: tokens.radius.sm }]}>
          <Text style={{ color: tokens.accentBlue.strong, fontSize: 9, fontWeight: tokens.fontWeight.bold }}>{String(count).padStart(2, '0')}</Text>
        </View>
      </View>
      <View style={styles.thumbRow}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { borderTopWidth: StyleSheet.hairlineWidth, marginTop: 14, paddingTop: 14, gap: 10 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  btnRow: { flexDirection: 'row', gap: 8 },
  iconBtn: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
  noteInput: { borderWidth: 1, borderRadius: 8, padding: 10, minHeight: 60, fontSize: 13, textAlignVertical: 'top' },
  audioRow: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 10 },
  waveform: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 2, height: 20 },
  waveBar: { width: 2, borderRadius: 1 },
  groupHeadRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 8 },
  countBadge: { paddingHorizontal: 6, paddingVertical: 1 },
  thumbRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  thumb: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center', gap: 2 },
});
