import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import { useAuth } from './auth';
import { am, en, type StringKey } from './strings';
import { supabase } from './supabase';

export type Language = 'en' | 'am';

/** The app opens in Amharic. It changes only when the person picks English (the አማ/EN pill), and then stays that way on this device. */
export const DEFAULT_LANGUAGE: Language = 'am';

const STORAGE_KEY = 'topup.language';
const DICTIONARIES: Record<Language, Record<StringKey, string>> = { en, am };

type Vars = Record<string, string | number>;

type I18nValue = {
  language: Language;
  setLanguage: (language: Language) => void;
  t: (key: StringKey, vars?: Vars) => string;
};

const I18nContext = createContext<I18nValue | undefined>(undefined);

function isLanguage(value: unknown): value is Language {
  return value === 'en' || value === 'am';
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const userId = user?.id;

  // The choice made on THIS device (AsyncStorage), so the app opens in the right language before anything has loaded and on the
  // login screens. null = nothing chosen yet: the default (Amharic) applies. The account's saved language is still updated when
  // the person switches, but it is not read back: a fresh device or account starts in Amharic, not in whatever a default said.
  const [stored, setStored] = useState<Language | null>(null);
  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY)
      .then((value) => {
        if (isLanguage(value)) setStored(value);
      })
      .catch(() => {});
  }, []);

  // A choice made in this session, remembered against the account that made it.
  const [chosen, setChosen] = useState<{ userId: string | undefined; language: Language } | null>(null);

  // Precedence: this session's choice, then this device's saved choice, then the default.
  const language: Language = chosen && chosen.userId === userId ? chosen.language : (stored ?? DEFAULT_LANGUAGE);

  const setLanguage = useCallback(
    (next: Language) => {
      setChosen({ userId, language: next });
      setStored(next);
      AsyncStorage.setItem(STORAGE_KEY, next).catch(() => {});
      if (userId) {
        supabase
          .from('profiles')
          .update({ language: next })
          .eq('id', userId)
          .then(() => {});
      }
    },
    [userId]
  );

  const t = useCallback(
    (key: StringKey, vars?: Vars) => {
      let text = DICTIONARIES[language][key] ?? en[key];
      if (vars) {
        for (const [name, value] of Object.entries(vars)) {
          text = text.split(`{${name}}`).join(String(value));
        }
      }
      return text;
    },
    [language]
  );

  const value = useMemo(() => ({ language, setLanguage, t }), [language, setLanguage, t]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error('useI18n must be used inside <I18nProvider>');
  return ctx;
}

/** Shorthand: `const t = useT();` */
export function useT() {
  return useI18n().t;
}
