import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import { Toast } from '../components/market/Toast';

const TOAST_MS = 2600;

const ToastContext = createContext<(message: string) => void>(() => {});

/** Wrap the app once; any screen can then call `useToast()('message')`. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState({ message: '', visible: false });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    []
  );

  const show = useCallback((message: string) => {
    if (timer.current) clearTimeout(timer.current);
    setToast({ message, visible: true });
    timer.current = setTimeout(
      () => setToast((t) => ({ ...t, visible: false })),
      TOAST_MS
    );
  }, []);

  const value = useMemo(() => show, [show]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <Toast message={toast.message} visible={toast.visible} />
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext);
}
