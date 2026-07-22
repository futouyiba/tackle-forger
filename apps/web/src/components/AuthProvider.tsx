"use client";

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { type Role, type Session, loadSession, saveSession, clearSession } from "@/lib/auth";

interface AuthContextValue {
  session: Session | null;
  ready: boolean;
  signIn: (session: Session) => void;
  signOut: () => void;
  hasRole: (...roles: Role[]) => boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setSession(loadSession());
    setReady(true);
  }, []);

  const value = useMemo<AuthContextValue>(() => ({
    session,
    ready,
    signIn: (next: Session) => { saveSession(next); setSession(next); },
    signOut: () => { clearSession(); setSession(null); },
    hasRole: (...roles: Role[]) => (session ? roles.includes(session.role) : false),
  }), [session, ready]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used within AuthProvider");
  return context;
}
