import { useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useAuthStore } from '@/store/useAuthStore';
import { useTheme } from '@/theme/ThemeProvider';

// Ports rack-audit-app.html's renderLogin (~line 1753): mark, warehouse
// label, email/password fields, inline error banner, submit button. `sb`
// being unconfigured in the source just always "succeeds" login (see
// useAuthStore.signIn) — same shortcut here for the mock-data-only mode.
export default function LoginScreen() {
  const { tokens } = useTheme();
  const signIn = useAuthStore((s) => s.signIn);
  const authError = useAuthStore((s) => s.error);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  const handleSubmit = async () => {
    setBusy(true);
    await signIn(email, password);
    setBusy(false);
  };

  return (
    <SafeAreaView style={[styles.safeArea, { backgroundColor: tokens.muted }]}>
      <View style={[styles.card, { backgroundColor: tokens.card, borderColor: tokens.border, borderRadius: tokens.radius.xxl }]}>
        <View style={[styles.mark, { backgroundColor: tokens.primary, borderRadius: tokens.radius.xl }]}>
          <Text style={{ color: tokens.primaryForeground, fontWeight: tokens.fontWeight.extrabold, fontSize: 22 }}>R</Text>
        </View>
        <Text style={[styles.h2, { color: tokens.foreground, fontWeight: tokens.fontWeight.extrabold }]}>RAMS 2.0</Text>
        <Text style={[styles.sub, { color: tokens.mutedForeground, fontSize: tokens.text.sm }]}>
          Inventory Reconciliation · Mobile
        </Text>

        <View style={styles.field}>
          <Text style={[styles.label, { color: tokens.mutedForeground, fontSize: tokens.text.xs }]}>Email</Text>
          <TextInput
            value={email}
            onChangeText={setEmail}
            placeholder="Enter email"
            placeholderTextColor={tokens.slate400}
            autoCapitalize="none"
            keyboardType="email-address"
            style={[styles.input, { color: tokens.foreground, borderColor: tokens.border, borderRadius: tokens.radius.lg, backgroundColor: tokens.inputBackground }]}
          />
        </View>
        <View style={styles.field}>
          <Text style={[styles.label, { color: tokens.mutedForeground, fontSize: tokens.text.xs }]}>Password</Text>
          <TextInput
            value={password}
            onChangeText={setPassword}
            placeholder="••••••••"
            placeholderTextColor={tokens.slate400}
            secureTextEntry
            onSubmitEditing={handleSubmit}
            style={[styles.input, { color: tokens.foreground, borderColor: tokens.border, borderRadius: tokens.radius.lg, backgroundColor: tokens.inputBackground }]}
          />
        </View>

        {authError ? (
          <View style={[styles.banner, { backgroundColor: tokens.rag.amber.soft, borderColor: tokens.rag.amber.border }]}>
            <Text style={{ color: tokens.rag.amber.strong, fontSize: tokens.text.sm }}>{authError}</Text>
          </View>
        ) : null}

        <View
          style={[styles.button, { backgroundColor: busy ? tokens.slate300 : tokens.primary, borderRadius: tokens.radius.lg }]}
          onTouchEnd={busy ? undefined : handleSubmit}
        >
          {busy ? (
            <ActivityIndicator color={tokens.primaryForeground} />
          ) : (
            <Text style={{ color: tokens.primaryForeground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.base }}>Log in</Text>
          )}
        </View>
        <Text style={[styles.foot, { color: tokens.mutedForeground, fontSize: tokens.text.xs }]}>
          Forgot password? Contact your supervisor
        </Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 20 },
  card: { width: '100%', maxWidth: 380, borderWidth: 1, padding: 24, alignItems: 'center', gap: 4 },
  mark: { width: 56, height: 56, alignItems: 'center', justifyContent: 'center', marginBottom: 8 },
  h2: { fontSize: 20 },
  sub: { marginBottom: 20 },
  field: { width: '100%', gap: 6, marginBottom: 14 },
  label: { fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.4 },
  input: { width: '100%', height: 46, borderWidth: 1, paddingHorizontal: 14 },
  banner: { width: '100%', borderWidth: 1, borderRadius: 8, padding: 10, marginBottom: 12 },
  button: { width: '100%', height: 46, alignItems: 'center', justifyContent: 'center', marginTop: 6 },
  foot: { marginTop: 16, textAlign: 'center' },
});
