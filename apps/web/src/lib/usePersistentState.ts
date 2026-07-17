"use client";

import { useEffect, useRef, useState } from "react";

export function usePersistentState<T>(key: string, initial: T): [T, React.Dispatch<React.SetStateAction<T>>, boolean] {
  const [state, setState] = useState<T>(initial);
  const [hydrated, setHydrated] = useState(false);
  const initialized = useRef(false);

  useEffect(() => {
    try {
      const raw = typeof window !== "undefined" ? window.localStorage.getItem(key) : null;
      if (raw) setState(JSON.parse(raw) as T);
    } catch {
      // 解析失败则回退到初始值
    }
    setHydrated(true);
    initialized.current = true;
  }, [key]);

  useEffect(() => {
    if (!initialized.current) return;
    try {
      window.localStorage.setItem(key, JSON.stringify(state));
    } catch {
      // 配额或隐私模式，静默忽略
    }
  }, [key, state]);

  return [state, setState, hydrated];
}

export function clearPersistentState(...keys: string[]): void {
  if (typeof window === "undefined") return;
  keys.forEach((key) => window.localStorage.removeItem(key));
}
