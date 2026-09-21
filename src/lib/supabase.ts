import 'react-native-url-polyfill/auto';

import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error(
    'Missing Supabase env vars. Check .env at the project root, then restart with: npx expo start -c'
  );
}

// Static web export renders in Node, where AsyncStorage's web build needs
// `window`. Skip session storage/refresh there; it runs normally on device
// and in the browser.
const isServer = typeof window === 'undefined';

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    storage: AsyncStorage,
    autoRefreshToken: !isServer,
    persistSession: !isServer,
    // No URL bar on mobile, so there is no session to read from one.
    detectSessionInUrl: false,
  },
});