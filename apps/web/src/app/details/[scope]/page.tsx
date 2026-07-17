"use client";

import { useParams } from "next/navigation";
import { useState } from "react";
import { AppShell } from "@/components/AppShell";
import { PageToolbar, ToolbarButton } from "@/components/EditableGrid";
import { skus, templates, parameters, type SkuRow } from "@/lib/mock-data";
import type { ParameterDefinition } from "@tackle-forger/domain";

const scopeConfig = {
  rod: { label: "杆", title: "杆明细", idSuffix: "_R", paramScope: "ROD" as const },
  reel: { label: "轮", title: "轮明细", idSuffix: "_W", paramScope: "REEL" as const },
  line: { label: "线", title: "线明细", idSuffix: "_L", paramScope: "LINE" as const },
};

export default function DetailPage() {
  const params = useParams<{ scope: "rod" | "reel" | "line" }>();
  const scope = params.scope ?? "rod";
  const config = scopeConfig[scope];
  const scopeParams = parameters.filter((parameter: ParameterDefinition) => parameter.scope === config.paramScope && parameter.category !== "辅助字段");

  const [overrides, setOverrides] = useState<Record<string, { model: string; name: string }>>({});

  const detailRows = skus.map((sku: SkuRow) => {
    const template = templates.find((item) => item.id === sku.templateId);
    const componentId = `${sku.comboCode}${config.idSuffix}`;
    const generatedModel = `${sku.seriesName}·${config.label}${sku.quality}`;
    const override = overrides[componentId];
    return {
      sku, template, componentId,
      generatedModel,
      model: override?.model ?? generatedModel,
      name: override?.name ?? `${sku.platformPositioning} ${config.label}`,
      isOverridden: Boolean(override),
    };
  });

  const setOverride = (componentId: string, field: "model" | "name", value: string) => {
    setOverrides((current) => {
      const existing = current[componentId] ?? { model: "", name: "" };
      return { ...current, [componentId]: { ...existing, [field]: value } };
    });
  };

  return (
    <AppShell
      title={config.title}
      subtitle="生产配置 · 按组件 ID 输出的具体配置"
      actions={<><ToolbarButton variant="secondary">导出明细</ToolbarButton><ToolbarButton variant="primary">保存覆盖</ToolbarButton></>}
    >
      <PageToolbar>
        <span className="toolbar-hint">每个 SKU 1:1 生成一条 {config.label}明细 · 型号/名字可自定义覆盖，覆盖后仍保留自动生成值</span>
      </PageToolbar>

      <div className="grid-scroll" style={{ maxHeight: "76vh" }}>
        <table className="data-grid">
          <thead>
            <tr>
              <th className="grid-row-label-col">组件 ID</th>
              <th>来源 SKU</th><th>型号（可覆盖）</th><th>名称（可覆盖）</th><th>品质</th><th>价格</th>
              {scopeParams.slice(0, 6).map((parameter) => <th key={parameter.key}>{parameter.displayName}</th>)}
              <th>状态</th>
            </tr>
          </thead>
          <tbody>
            {detailRows.map((row) => (
              <tr key={row.componentId}>
                <td className="grid-row-label"><strong style={{ color: "#eaf4f1" }}>{row.componentId}</strong></td>
                <td className="cell-static">{row.sku.comboCode} · {row.template?.name}</td>
                <td className="cell">
                  <input className="cell-input" value={row.model} onChange={(event) => setOverride(row.componentId, "model", event.target.value)} />
                </td>
                <td className="cell">
                  <input className="cell-input" value={row.name} onChange={(event) => setOverride(row.componentId, "name", event.target.value)} />
                </td>
                <td className="cell-static">{row.sku.quality}</td>
                <td className="cell-static align-right">{row.sku.price}</td>
                {scopeParams.slice(0, 6).map((parameter) => (
                  <td key={parameter.key} className="cell-static align-right">
                    {row.template?.values[parameter.key] !== undefined ? row.template?.values[parameter.key] : "—"}
                  </td>
                ))}
                <td className="cell-static">{row.isOverridden ? <span className="status-chip 待评审">已覆盖 ✎</span> : <span className="status-chip 已发布">自动</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="note-line">
        <strong>明细生成：</strong>由 SKU 的组件 ID（{`{组合ID}_${config.label === "杆" ? "R" : config.label === "轮" ? "W" : "L"}`}）驱动，1:1 输出。所有参数值均为规则层计算结果，可在此对单个组件的型号、命名做精调覆盖。
      </div>
    </AppShell>
  );
}
