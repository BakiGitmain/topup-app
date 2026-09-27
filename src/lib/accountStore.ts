import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

import { ACCOUNTS_INDEX_KEY, parseSavedAccounts, tokenKey, type SavedAccount } from './accountsLogic';

/**
 * Multi-account switching is phone-only. On a phone, refresh tokens go in the Keychain (iOS) / Keystore-backed
 * storage (Android) through expo-secure-store. The web has no equivalent: expo-secure-store doesn't run there, and
 * the only option is localStorage, readable by any script on the page -- so a single XSS bug would hand over EVERY
 * saved account instead of just the signed-in one. That trade isn't worth it for a phone-first shop.
 *
 * EXPO_PUBLIC_MULTI_ACCOUNT_WEB=1 turns it on for web anyway, falling back to localStorage. It exists only so the
 * whole flow can be tested in a browser; never ship a web build with it set.
 */
export const MULTI_ACCOUNT_ENABLED = Platform.OS !== 'web' || process.env.EXPO_PUBLIC_MULTI_ACCOUNT_WEB === '1';

const onWeb = Platform.OS === 'web';

function webStorage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

async function read(key: string): Promise<string | null> {
  if (onWeb) return webStorage()?.getItem(key) ?? null;
  return SecureStore.getItemAsync(key);
}

async function write(key: string, value: string): Promise<void> {
  if (onWeb) {
    webStorage()?.setItem(key, value);
    return;
  }
  // Only this device, only after the first unlock: a saved session never syncs to another device through a backup.
  await SecureStore.setItemAsync(key, value, { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY });
}

async function remove(key: string): Promise<void> {
  if (onWeb) {
    webStorage()?.removeItem(key);
    return;
  }
  await SecureStore.deleteItemAsync(key);
}

/** The list (names, emails, avatars, admin flag -- no secrets). Kept in the same secure storage anyway, so the
 * whole feature lives in one place. */
export async function loadSavedAccounts(): Promise<SavedAccount[]> {
  try {
    return parseSavedAccounts(await read(ACCOUNTS_INDEX_KEY));
  } catch {
    return [];
  }
}

export async function storeSavedAccounts(list: readonly SavedAccount[]): Promise<void> {
  await write(ACCOUNTS_INDEX_KEY, JSON.stringify(list));
}

export async function loadRefreshToken(id: string): Promise<string | null> {
  try {
    return await read(tokenKey(id));
  } catch {
    return null;
  }
}

export async function storeRefreshToken(id: string, token: string): Promise<void> {
  await write(tokenKey(id), token);
}

export async function forgetRefreshToken(id: string): Promise<void> {
  try {
    await remove(tokenKey(id));
  } catch {
    // Already gone.
  }
}
