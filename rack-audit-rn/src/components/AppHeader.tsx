import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAuthStore } from '@/store/useAuthStore';
import { applyShadow } from '@/theme/shadow';
import { useTheme } from '@/theme/ThemeProvider';

export type HeaderMenuItem = { label: string; onPress: () => void };

// Ports headerBlock (rack-audit-app.html ~1723): title/subtitle, optional
// back button, and either an avatar-triggered or overflow-triggered dropdown
// menu. The source's `singleSync` one-item-menu shortcut isn't ported —
// every screen here just gets the full menu button, since a direct sync icon
// vs. an overflow button isn't a meaningful distinction on a real device.
export function AppHeader({
  title,
  sub,
  showBack,
  avatar,
  menuItems,
  backgroundColor,
}: {
  title: string;
  sub?: string;
  showBack?: boolean;
  avatar?: boolean;
  menuItems?: HeaderMenuItem[];
  backgroundColor?: string;
}) {
  const { tokens } = useTheme();
  const inspector = useAuthStore((s) => s.inspector);
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <SafeAreaView
      edges={['top']}
      // Header and the screen's scrollable body are siblings — without this,
      // whichever renders later in the tree (the body) paints over this
      // header's absolutely-positioned dropdown once it extends past the
      // header's own bounds, on both iOS (paint order) and Android
      // (elevation-based stacking).
      style={{ backgroundColor: backgroundColor ?? tokens.card, borderBottomWidth: 1, borderBottomColor: tokens.border, zIndex: 20, elevation: 20 }}
    >
      <View style={styles.row}>
        {showBack ? (
          <Pressable onPress={() => router.back()} hitSlop={8} style={styles.iconBtn}>
            <Ionicons name="chevron-back" size={22} color={tokens.foreground} />
          </Pressable>
        ) : null}
        <View style={styles.titleWrap}>
          <Text numberOfLines={1} style={{ color: tokens.foreground, fontWeight: tokens.fontWeight.extrabold, fontSize: tokens.text.lg }}>
            {title}
          </Text>
          {sub ? (
            <Text numberOfLines={1} style={{ color: tokens.mutedForeground, fontSize: tokens.text.xs, marginTop: 2 }}>
              {sub}
            </Text>
          ) : null}
        </View>
        {menuItems && menuItems.length > 0 ? (
          <View>
            <Pressable
              onPress={() => setMenuOpen((o) => !o)}
              hitSlop={8}
              style={[
                styles.iconBtn,
                avatar ? { backgroundColor: tokens.primary, borderRadius: 999, width: 34, height: 34 } : null,
              ]}
            >
              {avatar ? (
                <Text style={{ color: tokens.primaryForeground, fontWeight: tokens.fontWeight.bold, fontSize: tokens.text.xs }}>
                  {inspector?.initials ?? '?'}
                </Text>
              ) : (
                <Ionicons name="ellipsis-vertical" size={20} color={tokens.foreground} />
              )}
            </Pressable>
            {menuOpen ? (
              <>
                <Pressable style={StyleSheet.absoluteFill} onPress={() => setMenuOpen(false)} />
                <View
                  style={[
                    styles.menu,
                    {
                      backgroundColor: tokens.popover,
                      borderColor: tokens.border,
                      borderRadius: tokens.radius.lg,
                      ...applyShadow(tokens.shadowCard),
                      // Android stacks by `elevation`, not `zIndex` — a card
                      // further down the screen (e.g. Dashboard's "Resume
                      // Audit" button) can have a higher elevation than
                      // shadowCard's own value and paint over this dropdown.
                      // Force it well above anything else on screen.
                      elevation: 50,
                    },
                  ]}
                >
                  {menuItems.map((m) => (
                    <Pressable
                      key={m.label}
                      onPress={() => {
                        setMenuOpen(false);
                        m.onPress();
                      }}
                      style={({ pressed }) => [styles.menuItem, { borderColor: tokens.border }, pressed ? { backgroundColor: tokens.muted } : null]}
                    >
                      <Text style={{ color: tokens.popoverForeground, fontSize: tokens.text.sm }}>{m.label}</Text>
                    </Pressable>
                  ))}
                </View>
              </>
            ) : null}
          </View>
        ) : null}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 10, gap: 10 },
  iconBtn: { width: 34, height: 34, alignItems: 'center', justifyContent: 'center' },
  titleWrap: { flex: 1, minWidth: 0 },
  menu: { position: 'absolute', top: 40, right: 0, minWidth: 150, borderWidth: 1, overflow: 'hidden', zIndex: 20 },
  menuItem: { paddingHorizontal: 14, paddingVertical: 11, borderBottomWidth: StyleSheet.hairlineWidth },
});
