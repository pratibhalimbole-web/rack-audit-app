import type { StyleProp, ViewStyle } from 'react-native';
import { StyleSheet, View } from 'react-native';
import { applyShadow } from '@/theme/shadow';
import { useTheme } from '@/theme/ThemeProvider';

// Ports .card (rounded, bordered, subtly-shadowed surface reused by every
// screen's cards, source lines ~150-165).
export function Card({ children, style }: { children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  const { tokens } = useTheme();
  return (
    <View
      style={[
        styles.card,
        {
          backgroundColor: tokens.card,
          borderColor: tokens.border,
          borderRadius: tokens.radius.xxl,
          ...applyShadow(tokens.shadowCard),
        },
        style,
      ]}
    >
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: 1, padding: 16 },
});
