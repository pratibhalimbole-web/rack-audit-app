import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
  Inter_800ExtraBold,
  useFonts,
} from '@expo-google-fonts/inter';
import { QueryClientProvider } from '@tanstack/react-query';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { queryClient } from '@/lib/queryClient';
import { useAuthStore } from '@/store/useAuthStore';
import { ThemeProvider, useTheme } from '@/theme/ThemeProvider';

SplashScreen.preventAutoHideAsync();

// Ports the source's boot() (rack-audit-app.html ~4498): restore a Supabase
// session (or go straight to "authed" in mock-data mode) before the first
// real screen renders. `Stack.Protected` (current SDK 57 pattern) replaces
// the source's manual `STATE.stack=['login']` shortcut.
function RootNavigator() {
  const status = useAuthStore((s) => s.status);
  const hydrate = useAuthStore((s) => s.hydrate);
  const { tokens } = useTheme();

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  if (status === 'loading') {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: tokens.muted }}>
        <ActivityIndicator color={tokens.primary} />
      </View>
    );
  }

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Protected guard={status === 'authed'}>
        <Stack.Screen name="(app)" />
        <Stack.Screen name="scan" options={{ presentation: 'modal' }} />
        <Stack.Screen name="pin-location" options={{ presentation: 'modal' }} />
      </Stack.Protected>
      <Stack.Protected guard={status !== 'authed'}>
        <Stack.Screen name="(auth)/login" />
      </Stack.Protected>
    </Stack>
  );
}

// Root layout — source of truth for provider order: fonts must resolve
// before anything renders (source app pulls Inter from a Google Fonts CDN
// <link>, this is the RN equivalent), then design-token theme, then the
// TanStack Query client every feature's data hooks depend on. This replaces
// rack-audit-app.html's single <script> block that just ran everything
// top-level before the first render() call.
export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
    Inter_800ExtraBold,
  });

  useEffect(() => {
    if (fontsLoaded || fontError) {
      SplashScreen.hideAsync();
    }
  }, [fontsLoaded, fontError]);

  // Previously gated the whole app on `if (!fontsLoaded && !fontError) return
  // null` — fine on a fast/reliable connection, but over a slow or flaky dev
  // tunnel the font asset requests can hang well past whatever timeout the
  // OS gives the splash screen, leaving a blank white screen with nothing to
  // recover it. Only two styles in the whole app actually reference the
  // Inter family explicitly (everywhere else uses fontWeight on the system
  // font), so there's nothing to lose by rendering immediately and letting
  // those two spots pick up Inter whenever it finishes loading.
  useEffect(() => {
    const timeout = setTimeout(() => SplashScreen.hideAsync(), 3000);
    return () => clearTimeout(timeout);
  }, []);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <ThemeProvider>
          <QueryClientProvider client={queryClient}>
            <RootNavigator />
          </QueryClientProvider>
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
