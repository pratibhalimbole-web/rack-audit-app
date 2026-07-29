import { Ionicons } from '@expo/vector-icons';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { useEffect, useRef } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';

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
}: {
  visible: boolean;
  title: string;
  hint: string;
  onScanned: (data: string) => void;
  onClose: () => void;
  onUseSimulated?: () => void;
}) {
  const [permission, requestPermission] = useCameraPermissions();
  const handledRef = useRef(false);

  useEffect(() => {
    if (visible) handledRef.current = false;
  }, [visible]);

  const handleBarcodeScanned = ({ data }: { data: string }) => {
    if (handledRef.current) return;
    handledRef.current = true;
    onScanned(data);
  };

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

        <View style={styles.headerRow}>
          <Text style={styles.title} numberOfLines={1}>
            {title}
          </Text>
          <Pressable onPress={onClose} hitSlop={10}>
            <Ionicons name="close" size={26} color="#fff" />
          </Pressable>
        </View>
        <View style={styles.footer}>
          <Text style={styles.hint}>{hint}</Text>
          {onUseSimulated ? (
            <Pressable
              onPress={() => {
                handledRef.current = true;
                onUseSimulated();
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
