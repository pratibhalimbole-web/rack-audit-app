import { StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '@/theme/ThemeProvider';

// Temporary stand-in for a route not yet built — replaced screen-by-screen
// per the phased build order (see the plan). Keeps navigation fully
// clickable end-to-end while content lands incrementally.
export function PlaceholderScreen({ title, note }: { title: string; note?: string }) {
  const { tokens } = useTheme();
  return (
    <SafeAreaView style={[styles.container, { backgroundColor: tokens.muted }]}>
      <Text style={[styles.title, { color: tokens.foreground, fontWeight: tokens.fontWeight.extrabold, fontSize: tokens.text.xl }]}>
        {title}
      </Text>
      {note ? (
        <Text style={[styles.note, { color: tokens.mutedForeground, fontSize: tokens.text.base }]}>{note}</Text>
      ) : null}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 8 },
  title: {},
  note: { textAlign: 'center' },
});
