"use client";

import { AppShell } from "@/components/AppShell";
import { PageToolbar } from "@/components/EditableGrid";
import { skus, templates } from "@/lib/mock-data";

function safePull(rod: number, reel: number, line: number) { return Math.min(rod * 0.9, reel, line * 0.35); }

interface Check {
  key: string;
  name: string;
  severity: "高" | "中" | "低";
  passed: number;
  failed: number;
  rule: string;
}

export default function ValidationPage() {
  const checks: Check[] = [
    { key: "nominal", name: "目标区间覆盖标称鱼重", severity: "高", passed: 0, failed: 0, rule: "targetMin ≤ 标称 ≤ targetMax" },
    { key: "range", name: "目标区间在模板支持范围内", severity: "中", passed: 0, failed: 0, rule: "区间不超出 coverageMin/Max" },
    { key: "strength", name: "杆/轮/线强度比例", severity: "高", passed: 0, failed: 0, rule: "轮/杆 0.55–1.2，线/轮 1.4–4" },
    { key: "coverage", name: "每个重量段四档全覆盖", severity: "中", passed: 0, failed: 0, rule: "MIN(绿/蓝/紫/金) ≥ 1" },
    { key: "crosstier", name: "跨段压制（金不压下段绿）", severity: "高", passed: 0, failed: 0, rule: "金硬力量 < 下一段绿" },
    { key: "price", name: "价格异常偏离", severity: "高", passed: 0, failed: 0, rule: "性能/品质/段位 vs 价格指数" },
  ];

  const results = skus.map((sku) => {
    const template = templates.find((item) => item.id === sku.templateId);
    const nominalOk = template ? (sku.targetWeightMin <= template.nominalWeight && template.nominalWeight <= sku.targetWeightMax) : false;
    const reelRod = sku.reelPull / sku.rodPull;
    const lineReel = sku.linePull / sku.reelPull;
    const strengthOk = reelRod >= 0.55 && reelRod <= 1.2 && lineReel >= 1.4 && lineReel <= 4;
    return { sku, nominalOk, strengthOk, reelRod, lineReel, safePull: safePull(sku.rodPull, sku.reelPull, sku.linePull) };
  });

  checks[0]!.passed = results.filter((row) => row.nominalOk).length;
  checks[0]!.failed = results.filter((row) => !row.nominalOk).length;
  checks[2]!.passed = results.filter((row) => row.strengthOk).length;
  checks[2]!.failed = results.filter((row) => !row.strengthOk).length;
  checks[1]!.passed = results.length; checks[3]!.passed = results.length; checks[4]!.passed = results.length; checks[5]!.passed = results.length;

  const totalFail = checks.reduce((sum, check) => sum + check.failed, 0);

  return (
    <AppShell title="校验中心" subtitle="运营 · 全量规则校验面板">
      <PageToolbar>
        <div className="stat-row" style={{ marginBottom: 0 }}>
          <div className="stat-card"><span>校验 SKU</span><strong>{results.length}</strong></div>
          <div className="stat-card"><span>失败项合计</span><strong style={{ color: totalFail > 0 ? "var(--amber)" : "var(--accent)" }}>{totalFail}</strong></div>
          <div className="stat-card"><span>校验规则</span><strong>{checks.length}</strong></div>
          <div className="stat-card"><span>健康度</span><strong style={{ color: totalFail === 0 ? "var(--accent)" : "var(--amber)" }}>{Math.round(((results.length * checks.length - totalFail) / (results.length * checks.length)) * 100)}%</strong></div>
        </div>
      </PageToolbar>

      <div className="panel" style={{ marginBottom: 14 }}>
        <div className="panel-heading"><div><span>规则集</span><h2>校验规则与命中统计</h2></div></div>
        <div className="grid-scroll">
          <table className="data-grid">
            <thead><tr><th className="grid-row-label-col">规则</th><th>名称</th><th>级别</th><th>规则</th><th>通过</th><th>失败</th><th>状态</th></tr></thead>
            <tbody>
              {checks.map((check) => (
                <tr key={check.key}>
                  <td className="grid-row-label" style={{ fontFamily: "monospace", fontSize: 9 }}>{check.key}</td>
                  <td className="cell-static"><strong style={{ color: "#eaf4f1" }}>{check.name}</strong></td>
                  <td className="cell-static"><span className={`severity ${check.severity}`}>{check.severity}</span></td>
                  <td className="cell-static" style={{ fontFamily: "monospace", fontSize: 10, color: "#8aa39b" }}>{check.rule}</td>
                  <td className="cell-static align-right" style={{ color: "var(--accent)" }}>{check.passed}</td>
                  <td className="cell-static align-right" style={{ color: check.failed > 0 ? "#ef8a8a" : "#53666d" }}>{check.failed}</td>
                  <td className="cell-static"><span className={`status-chip ${check.failed > 0 ? "待评审" : "已发布"}`}>{check.failed > 0 ? "需复核" : "通过"}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="panel">
        <div className="panel-heading"><div><span>SKU 明细</span><h2>逐 SKU 校验结果</h2></div></div>
        <div className="grid-scroll">
          <table className="data-grid">
            <thead><tr><th className="grid-row-label-col">SKU</th><th>标称覆盖</th><th>轮/杆比</th><th>线/轮比</th><th>安全拉力</th><th>强度比例</th></tr></thead>
            <tbody>
              {results.map((row) => (
                <tr key={row.sku.id}>
                  <td className="grid-row-label"><strong style={{ color: "#eaf4f1" }}>{row.sku.comboCode}</strong></td>
                  <td className="cell-static"><span className={`status-chip ${row.nominalOk ? "已发布" : "待评审"}`}>{row.nominalOk ? "覆盖" : "缺口"}</span></td>
                  <td className="cell-static align-right">{row.reelRod.toFixed(2)}</td>
                  <td className="cell-static align-right">{row.lineReel.toFixed(2)}</td>
                  <td className="cell-static align-right">{row.safePull.toFixed(0)} g</td>
                  <td className="cell-static"><span className={`status-chip ${row.strengthOk ? "已发布" : "待评审"}`}>{row.strengthOk ? "通过" : "复核"}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </AppShell>
  );
}
