"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { authenticate, demoUsers, roleLabel, saveSession, type Session } from "@/lib/auth";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("admin@tackle-forger");
  const [password, setPassword] = useState("admin");
  const [error, setError] = useState("");

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const session = authenticate(email.trim(), password);
    if (!session) { setError("邮箱或密码不正确，请使用下方演示账号"); return; }
    saveSession(session);
    router.push("/");
  };

  const quickLogin = (user: typeof demoUsers[number]) => {
    const session: Session = { email: user.email, name: user.name, role: user.role };
    saveSession(session);
    router.push("/");
  };

  return (
    <div className="login-screen">
      <div className="login-bg" />
      <div className="login-card">
        <div className="login-brand">
          <span className="brand-mark">铸</span>
          <div><strong>钓具铸造台</strong><small>装备设计系统</small></div>
        </div>
        <h1>登录工作区</h1>
        <p className="login-sub">分层钓具装备设计与 SKU 生成系统 · 角色决定可编辑范围</p>

        <form onSubmit={submit} className="login-form">
          <label>邮箱</label>
          <input value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="username" />
          <label>密码</label>
          <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" />
          {error && <div className="login-error">{error}</div>}
          <button type="submit" className="button primary" style={{ width: "100%", marginTop: 6 }}>登录</button>
        </form>

        <div className="login-demo">
          <span>演示账号（点击即登录）</span>
          <div className="demo-users">
            {demoUsers.map((user) => (
              <button key={user.email} className="demo-user" onClick={() => quickLogin(user)}>
                <span className="demo-avatar" style={{ color: user.role === "ADMIN" ? "#38d6a1" : user.role === "EDITOR" ? "#47c9e5" : "#819198" }}>{user.name.slice(0, 1)}</span>
                <div><strong>{user.name}</strong><small>{roleLabel[user.role]} · {user.email}</small></div>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
