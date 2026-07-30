import { Ionicons } from '@expo/vector-icons';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, StyleSheet, Text, View } from 'react-native';

// Ports openCameraScan/startCameraStream/cameraScanLoop (rack-audit-app.html
// ~4412-4491) — the source's real-device branch of every scan action
// (scanLocationQR, scanStorageLocationField, scanRackViewLoc, scanSku all
// check IS_REAL_MOBILE and open this before falling back to a fixture
// cycle). Since this app now runs in Expo Go on an actual phone, real
// scanning is the primary path here; "Use test scan instead" keeps the
// fixture-cycle fallback available for demoing without a printed QR code.
export function BarcodeScannerModal({
  visible,
  title,
  hint,
  onScanned,
  onClose,
  onUseSimulated,
  continuous,
  feedback,
  scanCount,
}: {
  visible: boolean;
  title: string;
  hint: string;
  onScanned: (data: string) => void;
  onClose: () => void;
  onUseSimulated?: () => void;
  // Batch-scanning mode (a handheld/bulk scanner firing several codes in a
  // row): re-arms after a short cooldown instead of requiring the modal to
  // close and reopen between every single item, and shows a transient
  // "Done"-style close button plus per-scan feedback rather than closing.
  continuous?: boolean;
  feedback?: { text: string; tone: 'success' | 'warning' | 'error' } | null;
  // Running tally for a batch-scan session, shown as a persistent counter
  // with a brief spinner pulse each time a new scan lands — so an inspector
  // firing through a dozen codes with a handheld scanner can tell at a
  // glance the app is keeping up, not just watch the transient banner.
  scanCount?: number;
}) {
  const [permission, requestPermission] = useCameraPermissions();
  const handledRef = useRef(false);
  const cooldownRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [pulsing, setPulsing] = useState(false);
  const pulseRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (visible) handledRef.current = false;
  }, [visible]);

  useEffect(
    () => () => {
      if (cooldownRef.current) clearTimeout(cooldownRef.current);
      if (pulseRef.current) clearTimeout(pulseRef.current);
    },
    [],
  );

  const rearm = () => {
    if (!continuous) return;
    if (cooldownRef.current) clearTimeout(cooldownRef.current);
    cooldownRef.current = setTimeout(() => {
      handledRef.current = false;
    }, 1200);
  };

  const handleBarcodeScanned = ({ data }: { data: string }) => {
    if (handledRef.current) return;
    handledRef.current = true;
    onScanned(data);
    rearm();
    if (continuous) {
      setPulsing(true);
      if (pulseRef.current) clearTimeout(pulseRef.current);
      pulseRef.current = setTimeout(() => setPulsing(false), 600);
    }
  };

  const feedbackStyle =
    feedback?.tone === 'success' ? styles.feedbackSuccess : feedback?.tone === 'error' ? styles.feedbackError : styles.feedbackWarning;

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={styles.container}>
        {permission?.granted ? (
          <CameraView
            style={StyleSheet.absoluteFill}
            barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
            onBarcodeScanned={handleBarcodeScanned}
          />
        ) : (
          <View style={styles.permissionWrap}>
            <Ionicons name="camera-outline" size={40} color="#fff" />
            <Text style={styles.permissionText}>Camera access is needed to scan QR codes.</Text>
            <Pressable onPress={requestPermission} style={styles.grantBtn}>
              <Text style={styles.grantBtnText}>Grant Camera Access</Text>
            </Pressable>
          </View>
        )}

        {permission?.granted ? (
          <View pointerEvents="none" style={styles.frame} />
        ) : null}

        {continuous && typeof scanCount === 'number' ? (
          <View style={styles.countBadge}>
            {pulsing ? <ActivityIndicator size="small" color="#fff" style={{ marginRight: 8 }} /> : null}
            <Text style={styles.countText}>{scanCount} scanned</Text>
          </View>
        ) : null}

        {feedback ? (
          <View style={[styles.feedbackBanner, feedbackStyle]}>
            <Text style={styles.feedbackText} numberOfLines={2}>
              {feedback.text}
            </Text>
          </View>
        ) : null}

        <View style={styles.headerRow}>
          <Text style={styles.title} numberOfLines={1}>
            {title}
          </Text>
          <Pressable onPress={onClose} hitSlop={10}>
            {continuous ? (
              <View style={styles.doneBtn}>
                <Text style={styles.doneBtnText}>Done</Text>
              </View>
            ) : (
              <Ionicons name="close" size={26} color="#fff" />
            )}
          </Pressable>
        </View>
        <View style={styles.footer}>
          <Text style={styles.hint}>{hint}</Text>
          {onUseSimulated ? (
            <Pressable
              onPress={() => {
                handledRef.current = true;
                onUseSimulated();
                rearm();
                if (continuous) {
                  setPulsing(true);
                  if (pulseRef.current) clearTimeout(pulseRef.current);
                  pulseRef.current = setTimeout(() => setPulsing(false), 600);
                }
              }}
              style={styles.simBtn}
            >
              <Text style={styles.simBtnText}>Use test scan instead</Text>
            </Pressable>
          ) : null}
        </View>
      </View>
    </Modal>
  );
}

const FRAME_SIZE = 220;

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  countBadge: {
    position: 'absolute',
    top: 100,
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.6)',
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  countText: { color: '#fff', fontWeight: '700', fontSize: 13 },
  feedbackBanner: { position: 'absolute', top: 150, left: 20, right: 20, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 10 },
  feedbackSuccess: { backgroundColor: 'rgba(22,163,74,0.92)' },
  feedbackWarning: { backgroundColor: 'rgba(217,119,6,0.92)' },
  feedbackError: { backgroundColor: 'rgba(220,38,38,0.92)' },
  feedbackText: { color: '#fff', fontWeight: '700', fontSize: 13, textAlign: 'center' },
  doneBtn: { backgroundColor: '#1b59f8', paddingHorizontal: 14, height: 32, alignItems: 'center', justifyContent: 'center', borderRadius: 8 },
  doneBtnText: { color: '#fff', fontWeight: '700', fontSize: 13 },
  permissionWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 14, padding: 32 },
  permissionText: { color: '#fff', textAlign: 'center', fontSize: 14 },
  grantBtn: { backgroundColor: '#1b59f8', paddingHorizontal: 20, height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 8 },
  grantBtnText: { color: '#fff', fontWeight: '700', fontSize: 14 },
  frame: {
    position: 'absolute',
    top: '50%',
    left: '50%',
    width: FRAME_SIZE,
    height: FRAME_SIZE,
    marginLeft: -FRAME_SIZE / 2,
    marginTop: -FRAME_SIZE / 2,
    borderWidth: 3,
    borderColor: '#fff',
    borderRadius: 16,
  },
  headerRow: {
    position: 'absolute',
    top: 56,
    left: 20,
    right: 20,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  title: { color: '#fff', fontWeight: '700', fontSize: 15, flex: 1, marginRight: 12 },
  footer: { position: 'absolute', bottom: 40, left: 20, right: 20, alignItems: 'center', gap: 14 },
  hint: { color: 'rgba(255,255,255,0.85)', fontSize: 12, textAlign: 'center' },
  simBtn: { borderWidth: 1, borderColor: 'rgba(255,255,255,0.6)', borderRadius: 8, paddingHorizontal: 18, height: 40, alignItems: 'center', justifyContent: 'center' },
  simBtnText: { color: '#fff', fontWeight: '600', fontSize: 13 },
});
