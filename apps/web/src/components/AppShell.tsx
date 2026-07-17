"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import { useAuth } from "@/components/AuthProvider";
import { roleColor, roleLabel } from "@/lib/auth";

export type NavItem = { label: string; href: string; count?: string };

export const navigation: Array<{ label: string; items: NavItem[] }> = [
  {
    label: "设计体系",
    items: [
      { label: "总览控制台", href: "/" },
      { label: "参数定义", href: "/parameters", count: "31" },
      { label: "重量模板", href: "/templates", count: "12" },
      { label: "规则层", href: "/layers", count: "8" },
      { label: "词条库", href: "/affixes", count: "46" },
      { label: "品质评分", href: "/quality" },
    ],
  },
  {
    label: "生产配置",
    items: [
      { label: "组合 SKU", href: "/skus", count: "32" },
      { label: "杆明细", href: "/details/rod" },
      { label: "轮明细", href: "/details/reel" },
      { label: "线明细", href: "/details/line" },
    ],
  },
  {
    label: "运营",
    items: [
      { label: "评审队列", href: "/reviews", count: "7" },
      { label: "规则提案", href: "/proposals", count: "3" },
      { label: "校验中心", href: "/validation" },
      { label: "工作簿导入导出", href: "/workbooks" },
    ],
  },
];

export function AppShell({ children, title, subtitle, actions }: {
  children: React.ReactNode;
  title: string;
  subtitle: string;
  actions?: React.ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const { session, signOut } = useAuth();
  const [navOpen, setNavOpen] = useState(false);

  const handleSignOut = () => { signOut(); router.push("/login"); };

  return (
    <div className="app-shell">
      <aside className={`sidebar ${navOpen ? "open" : ""}`}>
        <div className="brand">
          <span className="brand-mark">铸</span>
          <div>
            <strong>钓具铸造台</strong>
            <small>装备设计系统</small>
          </div>
        </div>
        <nav>
          {navigation.map((section) => (
            <section className="nav-section" key={section.label}>
              <h2>{section.label}</h2>
              {section.items.map((item) => (
                <Link
                  className={`nav-item ${item.href === pathname ? "active" : ""}`}
                  href={item.href}
                  key={item.href}
                  onClick={() => setNavOpen(false)}
                >
                  <span>{item.label}</span>
                  {item.count && <em>{item.count}</em>}
                </Link>
              ))}
            </section>
          ))}
        </nav>
        <div className="sidebar-footer">
          <div className="avatar" style={session ? { color: roleColor[session.role], borderColor: `${roleColor[session.role]}88`, background: `${roleColor[session.role]}1a` } : {}}>
            {session ? session.name.slice(0, 1) : "客"}
          </div>
          <div>
            <strong>{session ? session.name : "未登录"}</strong>
            <small>{session ? roleLabel[session.role] : "仅可查看"}</small>
          </div>
          {session
            ? <button className="icon-action" title="退出登录" onClick={handleSignOut}>⎋</button>
            : <Link className="icon-action" title="登录" href="/login" style={{ textDecoration: "none" }}>→</Link>}
        </div>
      </aside>

      <main className="workspace">
        <header className="topbar">
          <button className="nav-toggle" onClick={() => setNavOpen((open) => !open)} aria-label="切换导航">☰</button>
          <div className="topbar-title">
            <p>{subtitle}</p>
            <h1>{title}</h1>
          </div>
          {actions && <div className="top-actions">{actions}</div>}
        </header>
        <div className="content">{children}</div>
      </main>
    </div>
  );
}
