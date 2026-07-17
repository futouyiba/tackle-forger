export type Role = "ADMIN" | "EDITOR" | "VIEWER";

export interface Session {
  email: string;
  name: string;
  role: Role;
}

export const demoUsers: Array<{ email: string; password: string; name: string; role: Role }> = [
  { email: "admin@tackle-forger", password: "admin", name: "管理员", role: "ADMIN" },
  { email: "editor@tackle-forger", password: "editor", name: "设计师·林", role: "EDITOR" },
  { email: "viewer@tackle-forger", password: "viewer", name: "访客", role: "VIEWER" },
];

export const roleLabel: Record<Role, string> = { ADMIN: "管理员", EDITOR: "编辑者", VIEWER: "查看者" };

export const roleColor: Record<Role, string> = { ADMIN: "#38d6a1", EDITOR: "#47c9e5", VIEWER: "#819198" };

export const STORAGE_KEY = "tackle-forger-session";

export function canEdit(role: Role): boolean {
  return role === "ADMIN" || role === "EDITOR";
}

export function loadSession(): Session | null {
  if (typeof window === "undefined") return null;
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try { return JSON.parse(raw) as Session; } catch { return null; }
}

export function saveSession(session: Session): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
}

export function clearSession(): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(STORAGE_KEY);
}

export function authenticate(email: string, password: string): Session | null {
  const user = demoUsers.find((item) => item.email === email && item.password === password);
  if (!user) return null;
  return { email: user.email, name: user.name, role: user.role };
}
