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

/** The project URL and PUBLIC anon key (both already shipped in the app), for the rare direct auth call. */
export const SUPABASE_URL: string = supabaseUrl;
export const SUPABASE_ANON_KEY: string = supabaseAnonKey;

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
    // supabase-js defaults to 'implicit', which returns OAuth tokens in the URL #hash. Google sign-in (auth.tsx)
    // is built on PKCE: the callback carries ?code=, redeemed with exchangeCodeForSession against a verifier
    // stored here at sign-in time. Under the default, no verifier was ever stored and no ?code= ever came back.
    flowType: 'pkce',
  },
});