import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAuthStore } from '@/store/useAuthStore';
import { useTheme } from '@/theme/ThemeProvider';

// Profile Settings — reached from the avatar menu's "Settings" item on
// Dashboard/Tasks. Not part of the source rack-audit-app.html (which never
// built this screen out, its Settings menu item was a toast() stub) — built
// per the supplied reference design, adapted to this app's real data
// (Inspector's name/email/warehouse/role from useAuthStore, no fabricated
// fields) and to a single-column layout that holds up on both phone and
// tablet widths instead of the reference's wide fixed two-column split.
export function SettingsScreen() {
  const { tokens, mode, setMode } = useTheme();
  const inspector = useAuthStore((s) => s.inspector);
  const signOut = useAuthStore((s) => s.signOut);

  return (
    <View style={{ flex: 1, backgroundColor: tokens.muted }}>
      <SafeAreaView edges={['top']} style={{ backgroundColor: tokens.card, borderBottomWidth: 1, borderBottomColor: tokens.border }}>
        <View style={styles.headerRow}>
          <Pressable onPress={() => router.back()} hitSlop={8} style={styles.headerIconBtn}>
            <Ionicons name="chevron-back" size={22} color={tokens.foreground} />
          </Pressable>
          <Text style={[styles.headerTitle, { color: tokens.foreground, fontWeight: tokens.fontWeight.extrabold, fontSize: tokens.text.lg }]}>
            Profile Settings
          </Text>
          <Pressable hitSlop={8} style={styles.headerIconBtn}>
            <Ionicons name="notifications-outline" size={20} color={tokens.mutedForeground} />
          </Pressable>
          <View>
            <Pressable hitSlop={8} style={styles.headerIconBtn}>
              <Ionicons name="sync-outline" size={20} color={tokens.mutedForeground} />
            </Pressable>
            <View style={[styles.badge, { backgroundColor: tokens.rag.green.base }]}>
              <Text style={{ color: '#fff', fontSize: 9, fontWeight: '800' }}>+9</Text>
            </View>
          </View>
        </View>
      </SafeAreaView>

      <ScrollView contentContainerStyle={styles.body}>
        <View>
          <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.extrabold, fontSize: tokens.text.lg }}>Personal Details</Text>
          <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.sm, marginTop: 2 }}>
            Manage and update your personal information
          </Text>
          <View style={styles.profileRow}>
            <View style={[styles.photoPlaceholder, { backgroundColor: tokens.muted, borderRadius: tokens.radius.xl }]}>
              <Ionicons name="person" size={32} color={tokens.slate400} />
            </View>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.extrabold, fontSize: tokens.text.base }}>
                {inspector?.name ?? '—'}
              </Text>
              <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.sm, marginTop: 2 }}>{inspector?.email ?? '—'}</Text>
              <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm, marginTop: 2 }}>
                {inspector?.role ?? '—'}
              </Text>
              <Pressable style={[styles.outlineBtn, { borderColor: tokens.border, borderRadius: tokens.radius.lg }]}>
                <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.semibold, fontSize: tokens.text.sm }}>Edit Details</Text>
              </Pressable>
            </View>
          </View>
        </View>

        <View style={[styles.card, { backgroundColor: tokens.card, borderColor: tokens.border, borderRadius: tokens.radius.xl }]}>
          <View style={styles.cardRow}>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.extrabold, fontSize: tokens.text.base }}>Appearance</Text>
              <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.sm, marginTop: 2 }}>
                Choose how Rack Audit looks on this device
              </Text>
            </View>
          </View>
          <View style={[styles.segmented, { borderColor: tokens.border, borderRadius: tokens.radius.lg }]}>
            <Pressable
              onPress={() => setMode('light')}
              style={[styles.segmentBtn, mode === 'light' ? { backgroundColor: tokens.primary } : null]}
            >
              <Ionicons name="sunny-outline" size={16} color={mode === 'light' ? tokens.primaryForeground : tokens.foreground} />
              <Text style={{ color: mode === 'light' ? tokens.primaryForeground : tokens.foreground, fontWeight: tokens.fontWeight.semibold, fontSize: tokens.text.sm }}>
                Light
              </Text>
            </Pressable>
            <Pressable
              onPress={() => setMode('dark')}
              style={[styles.segmentBtn, mode === 'dark' ? { backgroundColor: tokens.primary } : null]}
            >
              <Ionicons name="moon-outline" size={16} color={mode === 'dark' ? tokens.primaryForeground : tokens.foreground} />
              <Text style={{ color: mode === 'dark' ? tokens.primaryForeground : tokens.foreground, fontWeight: tokens.fontWeight.semibold, fontSize: tokens.text.sm }}>
                Dark
              </Text>
            </Pressable>
          </View>
        </View>

        <View style={[styles.card, { backgroundColor: tokens.card, borderColor: tokens.border, borderRadius: tokens.radius.xl }]}>
          <View style={styles.cardRow}>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.extrabold, fontSize: tokens.text.base }}>Security & Privacy</Text>
              <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.sm, marginTop: 2 }}>
                Manage your security & privacy options to protect your personal information.
              </Text>
            </View>
            <Pressable style={[styles.outlineBtn, { borderColor: tokens.border, borderRadius: tokens.radius.lg }]}>
              <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.semibold, fontSize: tokens.text.sm }}>Change Password</Text>
            </Pressable>
          </View>
        </View>

        <View style={[styles.card, { backgroundColor: tokens.card, borderColor: tokens.border, borderRadius: tokens.radius.xl }]}>
          <View style={styles.cardRow}>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.extrabold, fontSize: tokens.text.base }}>Log Out</Text>
              <Text style={{ color: tokens.mutedForeground, fontSize: tokens.text.sm, marginTop: 2 }}>
                Securely sign out of your account and return to the login screen.
              </Text>
            </View>
            <Pressable onPress={() => signOut()} style={[styles.dangerBtn, { backgroundColor: tokens.rag.red.base, borderRadius: tokens.radius.lg }]}>
              <Text style={{ color: '#fff', fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.sm }}>Log Out</Text>
            </Pressable>
          </View>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  headerRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 10, gap: 10 },
  headerIconBtn: { width: 34, height: 34, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { flex: 1 },
  badge: { position: 'absolute', top: -2, right: -2, minWidth: 16, height: 16, borderRadius: 8, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 3 },
  body: { padding: 16, gap: 20, paddingBottom: 40 },
  profileRow: { flexDirection: 'row', gap: 16, marginTop: 16, alignItems: 'flex-start' },
  photoPlaceholder: { width: 100, height: 100, alignItems: 'center', justifyContent: 'center' },
  outlineBtn: { borderWidth: 1, height: 40, paddingHorizontal: 16, alignItems: 'center', justifyContent: 'center', marginTop: 10, alignSelf: 'flex-start' },
  card: { borderWidth: 1, padding: 16, gap: 14 },
  cardRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 12 },
  segmented: { flexDirection: 'row', borderWidth: 1, padding: 3 },
  segmentBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, height: 40, borderRadius: 6 },
  dangerBtn: { height: 40, paddingHorizontal: 18, alignItems: 'center', justifyContent: 'center' },
});
