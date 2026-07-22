import { useEffect, useMemo, useState } from "react";
import {
  ArrowsLeftRight,
  BezierCurve,
  BookOpen,
  CaretDown,
  CaretLeft,
  CaretRight,
  ChartPolar,
  Check,
  ClockCounterClockwise,
  Database,
  FileText,
  Flask,
  Gear,
  GitDiff,
  HardDrives,
  ListMagnifyingGlass,
  MagicWand,
  MagnifyingGlass,
  Package,
  Plus,
  Robot,
  ShieldCheck,
  SidebarSimple,
  Sparkle,
  Stack,
  Target,
  TrendUp,
  User,
  Warning,
  X,
} from "@phosphor-icons/react";
import {
  PolarAngleAxis,
  PolarGrid,
  Radar,
  RadarChart,
  ResponsiveContainer,
} from "recharts";

const sourceRows = [
  { name: "杆最大拉力", unit: "kgf", value: "1.80", base: "1.70", method: "+0.05", type: "+0.00", fn: "+0.05", perf: "+0.10", bundle: "—", series: "+0.05", sku: "+0.00", model: "+0.00", source: 12 },
  { name: "杆自重", unit: "g", value: "182", base: "190", method: "−5", type: "−3", fn: "−5", perf: "−2", bundle: "—", series: "−2", sku: "−3", model: "−0", source: 14 },
  { name: "抛投指数", unit: "0–100", value: "72", base: "68", method: "+2", type: "+1", fn: "+3", perf: "+2", bundle: "+1", series: "+2", sku: "+1", model: "+1", source: 16, selected: true },
  { name: "耐久度", unit: "0–100", value: "76", base: "70", method: "+2", type: "+1", fn: "+2", perf: "+1", bundle: "+1", series: "+1", sku: "+1", model: "+0", source: 18 },
  { name: "操控性", unit: "0–100", value: "65", base: "64", method: "+1", type: "+1", fn: "+1", perf: "+0", bundle: "+1", series: "+1", sku: "+0", model: "+0", source: 16 },
  { name: "收线速度", unit: "0–100", value: "61", base: "60", method: "+1", type: "+1", fn: "+0", perf: "+0", bundle: "+1", series: "+1", sku: "+0", model: "+0", source: 16 },
  { name: "强度保持率", unit: "%", value: "88", base: "86", method: "+1", type: "+1", fn: "+1", perf: "+0", bundle: "+1", series: "+1", sku: "+1", model: "+0", source: 18 },
  { name: "抛投稳定性", unit: "0–100", value: "74", base: "73", method: "+1", type: "+0", fn: "+1", perf: "+0", bundle: "+1", series: "+1", sku: "+0", model: "+0", source: 16 },
];

const radarData = [
  { axis: "拉力强度", model: 78, series: 70 },
  { axis: "抛投能力", model: 72, series: 68 },
  { axis: "操控响应", model: 65, series: 64 },
  { axis: "耐久可靠", model: 76, series: 70 },
  { axis: "感知反馈", model: 61, series: 60 },
];

const navGroups = [
  {
    label: "建模",
    items: [
      { id: "library", label: "钓具库", icon: Package },
      { id: "templates", label: "模板库", icon: Stack },
      { id: "types", label: "类型与定位", icon: Target },
      { id: "rules", label: "规则与公式", icon: BezierCurve },
      { id: "affix", label: "词条与技术", icon: Flask },
    ],
  },
  {
    label: "生产与发布",
    items: [
      { id: "gantt", label: "钓具系列甘特图", icon: ChartPolar },
      { id: "sku", label: "SKU 抽屉", icon: HardDrives },
      { id: "models", label: "Model 管理", icon: FileText },
      { id: "publish", label: "发布管理", icon: ShieldCheck, count: 2 },
    ],
  },
  {
    label: "分析与治理",
    items: [
      { id: "compare", label: "数据对比", icon: ArrowsLeftRight },
      { id: "compatibility", label: "兼容性检查", icon: ListMagnifyingGlass },
      { id: "impact", label: "规则影响分析", icon: GitDiff },
    ],
  },
];

const ganttSeries = [
  {
    name: "青芦·远投",
    concept: "远投专用 · 纺车 + 直柄",
    color: "#0b8f8a",
    skus: [
      { weight: 1.0, label: "1.0 kg", models: 2, status: "已发布" },
      { weight: 1.5, label: "1.5 kg", models: 3, status: "有升级候选" },
      { weight: 1.8, label: "1.8 kg", models: 2, status: "待发布", active: true },
      { weight: 2.0, label: "2.0 kg", models: 2, status: "草稿" },
    ],
  },
  {
    name: "赤潮·重障",
    concept: "重障专精 · 鼓轮 + 枪柄",
    color: "#d36a3a",
    skus: [
      { weight: 1.5, label: "1.5 kg", models: 1, status: "已发布" },
      { weight: 2.0, label: "2.0 kg", models: 3, status: "待复核" },
      { weight: 2.5, label: "2.5 kg", models: 2, status: "硬冲突" },
    ],
  },
  {
    name: "澄波·感知",
    concept: "感知反馈 · 纺车 + 直柄",
    color: "#7250cf",
    skus: [
      { weight: 0.5, label: "0.5 kg", models: 2, status: "已发布" },
      { weight: 1.0, label: "1.0 kg", models: 2, status: "已发布" },
      { weight: 1.5, label: "1.5 kg", models: 1, status: "Patch rebase" },
    ],
  },
];

function NavItem({ item, active, onClick }) {
  const Icon = item.icon;
  return (
    <button className={"nav-item " + (active ? "active" : "")} onClick={() => onClick(item.id)}>
      <Icon size={18} weight={active ? "fill" : "regular"} />
      <span>{item.label}</span>
      {item.count ? <em>{item.count}</em> : null}
    </button>
  );
}

function Status({ type, children }) {
  return <span className={"status status-" + type}>{children}</span>;
}

function AppShell({ children, activeView, onNavigate }) {
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark"><Target size={20} weight="duotone" /></div>
          <div><strong>钓具配置工坊</strong><small>TACKLE FORGER</small></div>
        </div>
        <button className="overview"><User size={17} />总览</button>
        <nav>
          {navGroups.map((group) => (
            <section key={group.label} className="nav-group">
              <p>{group.label}</p>
              {group.items.map((item) => (
                <NavItem key={item.id} item={item} active={item.id === activeView} onClick={onNavigate} />
              ))}
            </section>
          ))}
        </nav>
        <div className="profile">
          <span className="avatar">Z</span>
          <span><strong>张策划</strong><small>游戏策划组</small></span>
          <Gear size={18} />
        </div>
      </aside>
      {children}
    </div>
  );
}

function Topbar({ onSearch }) {
  return (
    <header className="topbar">
      <div className="breadcrumbs">
        <button aria-label="返回"><CaretLeft size={17} /></button>
        <span>青芦系列</span><b>/</b><span>青芦·远投</span><b>/</b><span>1.8 kg 抽屉</span><b>/</b><strong>青芦·远投 T04-18</strong>
      </div>
      <button className="search" onClick={onSearch}><MagnifyingGlass size={16} />搜索 Model / 属性 / 规则 / 词条 <kbd>⌘ K</kbd></button>
    </header>
  );
}

function ContextHeader({ onBackGantt }) {
  return (
    <>
      <div className="context-header">
        <button className="context-block series" onClick={onBackGantt}>
          <span className="object-label">Series</span>
          <strong>青芦·远投</strong>
          <small>远投专用　|　纺车 + 直柄</small>
        </button>
        <div className="context-block sku">
          <span className="object-label">SKU 抽屉</span>
          <strong>1.8 kg <i></i></strong>
          <small>目标下限 1.5 kg　|　目标上限 2.0 kg</small>
        </div>
        <div className="context-block model">
          <span className="object-label">Model <em>当前对象</em></span>
          <strong>青芦·远投 T04-18 <Status type="quality">A 品质</Status></strong>
          <small>功能专精强度 2</small>
        </div>
      </div>
      <div className="subtabs">
        <button className="active">属性比较</button>
        <button>词条与技术</button>
        <button>适用场景</button>
        <button>计算轨迹</button>
        <button>兼容性检查</button>
        <button>发布校验</button>
      </div>
    </>
  );
}

function MatrixTable() {
  const columns = [
    ["base", "基础模板", "T04"],
    ["method", "钓法", "远投"],
    ["type", "类型", "纺车+直柄"],
    ["fn", "功能", "远投专用"],
    ["perf", "性能", "远投轻量"],
    ["bundle", "词条/技术", "4 项"],
    ["series", "Series Patch", "青芦·远投"],
    ["sku", "SKU Patch", "1.8 kg"],
    ["model", "Model Patch", "T04-18"],
  ];
  return (
    <div className="matrix-wrap">
      <table className="matrix-table">
        <thead>
          <tr>
            <th className="drag-col">☆</th>
            <th className="attr-col">属性</th>
            <th className="value-col">最终值 <span>ⓘ</span></th>
            {columns.map((column) => <th key={column[0]}>{column[1]}<small>{column[2]}</small></th>)}
          </tr>
        </thead>
        <tbody>
          {sourceRows.map((row) => (
            <tr key={row.name} className={row.selected ? "selected" : ""}>
              <td className="drag-col">⠿</td>
              <td className="attr-col"><strong>{row.name}</strong><small>{row.unit}</small><button>来源 {row.source} <CaretRight size={10} /></button></td>
              <td className="value-col">{row.value}</td>
              {["base","method","type","fn","perf","bundle","series","sku","model"].map((key) => (
                <td key={key} className={String(row[key]).includes("+") ? "positive" : ""}>{row[key]}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="matrix-footer">
        <span>共 8 项属性　选中 1 项：抛投指数</span>
        <span className="legend"><i className="up"></i> 增益　<i className="neutral"></i> 中性　<i className="down"></i> 降低　<i className="none"></i> 无影响</span>
      </div>
    </div>
  );
}

function ValidationBoard({ onOpenDrawer }) {
  return (
    <div className="validation-grid">
      <section className="validation hard">
        <header><strong><Warning size={17} weight="fill" />硬兼容（阻断）</strong><Status type="danger">2 项</Status></header>
        <div className="issue">
          <strong>拉力下限未满足</strong><Status type="danger">阻断</Status>
          <p>杆最大拉力 1.80 kgf 低于 SKU 目标下限 1.80 kgf 的安全冗余要求。</p>
          <small>影响属性：杆最大拉力</small><button>定位到词条</button>
        </div>
        <div className="issue">
          <strong>词条冲突：重心偏移 与 轻量化 III</strong><Status type="danger">阻断</Status>
          <p>两条规则同时生效会突破稳定性与轻量化冲突带。</p>
          <small>影响属性：抛投稳定性、杆自重</small><button>定位到词条</button>
        </div>
      </section>
      <section className="validation affinity">
        <header><strong><TrendUp size={17} />亲和力轴（非阻断，用于优化）</strong><Status type="info">3 轴</Status><button onClick={onOpenDrawer}>权重说明</button></header>
        {[
          ["远投表现轴", 78, "投距、操控稳定性、抛投性能"],
          ["操控手感轴", 66, "操控性、收线速度、重心分布"],
          ["耐用可靠轴", 70, "耐久度、强度保持率、材质耐磨"],
        ].map(([name, value, desc]) => (
          <div className="score-row" key={name}>
            <span><b>{name}</b><small>{desc}</small></span>
            <div className="bar"><i style={{ width: value + "%" }}></i></div>
            <em>{value} / 100</em>
          </div>
        ))}
      </section>
      <section className="siblings">
        <header><strong>关联同模</strong></header>
        <p>Model</p>
        <button>青芦·远投 T04-15</button>
        <button className="active">青芦·远投 T04-18 <small>（当前）</small></button>
        <p>两种抽屉</p>
      </section>
    </div>
  );
}

function MatrixWorkspace({ onOpenDrawer, onOpenAI, onCandidate, onBackGantt }) {
  return (
    <main className="workspace">
      <Topbar onSearch={() => {}} />
      <ContextHeader onBackGantt={onBackGantt} />
      <div className="matrix-toolbar">
        <div className="matrix-title"><span className="pulse"></span>派生结果 <small>规则 v3.8 · 最近模板 T04</small></div>
        <div>
          <button className="btn subtle" onClick={onOpenAI}><Robot size={16} />AI 评估与建议</button>
          <button className="btn primary" onClick={onCandidate}><Sparkle size={16} />生成 Model 候选<CaretDown size={14} /></button>
          <button className="btn" onClick={onOpenDrawer}><SidebarSimple size={16} />预览 Model</button>
        </div>
      </div>
      <MatrixTable />
      <ValidationBoard onOpenDrawer={onOpenDrawer} />
    </main>
  );
}

function DrawerTabs({ mode, setMode }) {
  return (
    <div className="drawer-tabs">
      <button className={mode === "preview" ? "active" : ""} onClick={() => setMode("preview")}>Model 预览</button>
      <button className={mode === "ai" ? "active" : ""} onClick={() => setMode("ai")}>AI评估与建议 <Status type="ai">AI</Status></button>
    </div>
  );
}

function RadarBlock() {
  return (
    <section className="radar-section">
      <header><strong>五维属性雷达</strong><button>查看来源</button></header>
      <div className="radar-layout">
        <div className="radar-box">
          <ResponsiveContainer width="100%" height="100%">
            <RadarChart data={radarData} outerRadius="72%">
              <PolarGrid stroke="#dce2ea" />
              <PolarAngleAxis dataKey="axis" tick={{ fontSize: 11, fill: "#39465b" }} />
              <Radar name="Series 基准" dataKey="series" stroke="#768395" fill="#9aa4b2" fillOpacity={0.22} strokeWidth={2} />
              <Radar name="当前 Model" dataKey="model" stroke="#6845e4" fill="#7c56ef" fillOpacity={0.18} strokeWidth={2.3} />
            </RadarChart>
          </ResponsiveContainer>
        </div>
        <div className="radar-values">
          <div className="radar-legend"><span className="purple"></span>当前 Model <span className="gray"></span>Series 基准</div>
          {radarData.map((item) => <p key={item.axis}><span>{item.axis}</span><b>{item.model}</b><em>/ {item.series}</em></p>)}
        </div>
      </div>
    </section>
  );
}

function KeyDetails() {
  return (
    <>
      <div className="detail-columns">
        <section><strong>关键数值</strong><p><span>杆最大拉力</span><b>1.80 kgf</b></p><p><span>杆自重</span><b>182 g</b></p><p><span>抛投指数</span><b>72</b></p><p><span>耐久度</span><b>76</b></p><p><span>操控性</span><b>65</b></p></section>
        <section><strong>装备配置概览</strong><p><span>配竿类型</span><b>纺车 + 直柄</b></p><p><span>推荐 reel</span><b>2500–3000 型</b></p><p><span>推荐线组</span><b>PE 1.0–1.5 号</b></p><p><span>适用场景</span><b>远投专用</b></p></section>
        <section><strong>词条与技术 <button>查看来源</button></strong><p>重心偏移 II</p><p>轻量化 III</p><p>导环防缠优化 I</p><p>高弹碳布层叠 II</p></section>
      </div>
      <section className="patch-chain">
        <header><strong>Patch 完整链路 <small>(4/4)</small></strong><button>查看来源</button></header>
        <div><span>Series：青芦·远投 <Check /></span><span>SKU：1.8 kg <Check /></span><span>Model：T04-18 <Check /></span></div>
      </section>
    </>
  );
}

function AISummary({ expanded = false, onAction, patchCreated }) {
  const suggestions = [
    {
      title: "拉力下限风险接近",
      text: "杆最大拉力仅贴近 SKU 安全下限，且低于系列均值 1.93 kgf，建议提升冗余。",
      impact: "影响范围：杆最大拉力",
    },
    {
      title: "词条组合存在冲突倾向",
      text: "重心偏移与轻量化 III 同时生效时，稳定性与自重存在竞争。",
      impact: "影响范围：抛投稳定性、杆自重",
    },
    {
      title: "操控响应可小幅优化",
      text: "当前操控响应略高于系列基准，但低于同重量层 P75，可作为非阻断优化。",
      impact: "影响范围：操控性",
    },
  ];
  return (
    <section className={"ai-summary " + (expanded ? "expanded" : "")}>
      <header><strong><Robot size={17} weight="duotone" />AI评估与建议</strong><small>辅助建议 · 不影响系统校验</small><Status type="ai">AI</Status></header>
      {suggestions.slice(0, expanded ? 3 : 2).map((item, index) => (
        <article key={item.title}>
          <div><b>{index + 1}. {item.title}</b><button>依据 <CaretRight size={11} /></button></div>
          <p>{item.text}</p>
          <small>{item.impact}</small>
          <span className="ai-actions">
            <button onClick={() => onAction("已打开修改预览；原值保持不变。")}>预览修改 <CaretRight size={12} /></button>
            <button onClick={() => onAction("已生成 Model Patch 草稿，等待人工确认。")}>{patchCreated ? "Patch 草稿已生成" : "生成 Model Patch 草稿"}</button>
          </span>
        </article>
      ))}
      <footer><button onClick={() => onAction("已创建飞书规则变更提案草稿，尚未提交。")}>转为飞书规则提案 <CaretRight size={13} /></button></footer>
    </section>
  );
}

function ValidationSummary() {
  return (
    <div className="drawer-validation">
      <section className="mini-hard"><header><strong>硬兼容（阻断）</strong><Status type="danger">阻断 2 项</Status></header><p>拉力下限未满足 <b>阻断</b></p><p>词条冲突：重心偏移与轻量化 III <b>阻断</b></p></section>
      <section className="mini-affinity"><header><strong>亲和力（非阻断）</strong><button>查看来源</button></header><p><span>综合评分</span><b>72 / 100</b></p><p><span>远投表现轴</span><b>78 / 100</b></p><p><span>操控手感轴</span><b>66 / 100</b></p><p><span>耐用可靠轴</span><b>70 / 100</b></p></section>
    </div>
  );
}

function Invariants() {
  return (
    <section className="invariants">
      <header><strong>系列不变量</strong><button>查看来源</button></header>
      <p><Check />类型必须为「纺车」<Status type="success">继承</Status></p>
      <p><Check />钓法必须为「远投」<Status type="success">继承</Status></p>
      <p><Check />适用场景必须为「远投专用」<Status type="success">继承</Status></p>
      <p><Warning />杆自重 ≤ 200 g（建议）<Status type="review">允许偏移 · 182 g</Status></p>
    </section>
  );
}

function PreviewDrawer({ open, mode, setMode, onClose, onToast, patchCreated }) {
  if (!open) return null;
  return (
    <>
      <div className="workspace-scrim" onClick={onClose}></div>
      <aside className="preview-drawer" aria-label="Model 预览与 AI 建议">
        <header className="drawer-head">
          <DrawerTabs mode={mode} setMode={setMode} />
          <div><kbd>esc</kbd><span>关闭预览</span><button aria-label="关闭预览" onClick={onClose}><X size={18} /></button></div>
        </header>
        {mode === "preview" ? (
          <>
            <div className="drawer-body">
              <section className="model-identity">
                <div><h2>青芦·远投 T04-18</h2><Status type="quality">A 品质</Status><Status type="warning">待发布</Status></div>
                <p>父级：1.8 kg SKU 抽屉　<Status type="model">Model</Status></p>
                <span>钓法：远投</span><span>类型：纺车 + 直柄</span><span>功能专精强度：2</span><span>最近模板：T04 · 未插值</span>
              </section>
              <RadarBlock />
              <KeyDetails />
              <AISummary onAction={onToast} patchCreated={patchCreated} />
              <ValidationSummary />
              <Invariants />
            </div>
            <footer className="drawer-footer"><button className="primary">打开完整 Model</button><button>加入比较</button></footer>
          </>
        ) : (
          <>
            <div className="drawer-body ai-mode">
              <section className="ai-intro">
                <span><Robot size={26} weight="duotone" /></span>
                <div><h2>AI评估与建议</h2><p>基于当前派生链路、系列基准与兼容结果生成。建议不会改变规则、Patch 或已发布快照。</p></div>
              </section>
              <div className="ai-guardrail"><ShieldCheck size={18} />系统校验优先：当前仍有 2 项硬冲突，AI 不会覆盖或降级这些阻断。</div>
              <AISummary expanded onAction={onToast} patchCreated={patchCreated} />
              <section className="ai-evidence">
                <header><strong>本次评估依据</strong><button>查看完整来源</button></header>
                <p><span>派生模板</span><b>T04 · 权重规则 v3.8</b></p>
                <p><span>系列基准</span><b>青芦·远投 · 7 个已发布 Model</b></p>
                <p><span>兼容结果</span><b>硬规则 v2.6 · Affinity v1.9</b></p>
                <p><span>评估生成时间</span><b>2026-07-20 15:42</b></p>
              </section>
            </div>
            <footer className="drawer-footer"><button onClick={() => onToast("AI 建议已刷新；系统校验结果未改变。")} className="primary"><MagicWand size={16} />重新评估</button><button onClick={() => setMode("preview")}>返回 Model 预览</button></footer>
          </>
        )}
      </aside>
    </>
  );
}

function GanttWorkspace({ onOpenModel, onCandidate, onCreate, onToast }) {
  const [selectedSeries, setSelectedSeries] = useState("qinglu");
  const weightBands = [
    { name: "重量段1", range: "0.1–0.8kg" },
    { name: "重量段2", range: "0.8–3kg" },
    { name: "重量段3", range: "4–8kg" },
    { name: "重量段4", range: "8–20kg" },
    { name: "重量段5", range: "20–50kg" },
    { name: "重量段6", range: "50–100kg" },
  ];
  const qualities = [
    { name: "C", className: "quality-c" },
    { name: "B", className: "quality-b" },
    { name: "A", className: "quality-a" },
    { name: "S", className: "quality-s" },
  ];
  const lanes = [
    "纺车 · 直柄", "鼓轮 · 枪柄",
    "纺车 · 直柄", "鼓轮 · 枪柄",
    "纺车 · 直柄", "鼓轮 · 枪柄",
    "纺车 · 直柄", "鼓轮 · 枪柄",
  ];
  const series = [
    {
      id: "lightwind", name: "松风·轻巧", concept: "轻型通用", quality: "C", type: "纺车 · 直柄",
      lane: 0, start: 1, span: 3, color: "#17a58c", status: "不变量通过", statusType: "success",
      nodes: [{ weight: "0.8kg", models: 2 }, { weight: "1.5kg", models: 2 }, { weight: "4.0kg", models: 1 }],
    },
    {
      id: "clearwave", name: "澄波·感知", concept: "感知反馈", quality: "B", type: "纺车 · 直柄",
      lane: 2, start: 0, span: 3, color: "#4288dd", status: "Patch rebase", statusType: "rebase",
      nodes: [{ weight: "0.5kg", models: 2 }, { weight: "1.0kg", models: 2 }, { weight: "1.5kg", models: 1 }],
    },
    {
      id: "shore", name: "近岸·泛用", concept: "近投 + 轻桥天远投", quality: "B", type: "鼓轮 · 枪柄",
      lane: 3, start: 1, span: 4, color: "#3f83d8", status: "待复核", statusType: "review",
      nodes: [{ weight: "1.0kg", models: 2 }, { weight: "1.5kg", models: 2 }, { weight: "1.8kg", models: 2 }, { weight: "2.0kg", models: 2 }],
    },
    {
      id: "qinglu", name: "青芦·远投", concept: "远投专用", quality: "A", type: "纺车 · 直柄",
      lane: 4, start: 0, span: 4, color: "#7152d6", status: "不变量通过", statusType: "success",
      nodes: [{ weight: "1.0kg", models: 2 }, { weight: "1.5kg", models: 3 }, { weight: "1.8kg", models: 2 }, { weight: "2.0kg", models: 2 }],
    },
    {
      id: "redtide", name: "赤潮·重障", concept: "重障操作", quality: "A", type: "鼓轮 · 枪柄",
      lane: 5, start: 2, span: 3, color: "#7651d0", status: "有升级候选", statusType: "upgrade",
      nodes: [{ weight: "1.5kg", models: 1 }, { weight: "2.0kg", models: 3 }, { weight: "2.5kg", models: 2 }],
    },
    {
      id: "ultimatecast", name: "极致·远投", concept: "极致跨距", quality: "S", type: "纺车 · 直柄",
      lane: 6, start: 1, span: 4, color: "#e27a3d", status: "待复核", statusType: "review",
      nodes: [{ weight: "1.8kg", models: 2 }, { weight: "2.0kg", models: 2 }, { weight: "2.5kg", models: 2 }],
    },
    {
      id: "giant", name: "极致·巨物", concept: "极致大物", quality: "S", type: "鼓轮 · 枪柄",
      lane: 7, start: 3, span: 3, color: "#db6e3a", status: "硬冲突", statusType: "danger",
      nodes: [{ weight: "2.5kg", models: 2 }, { weight: "5.0kg", models: 1 }, { weight: "10.0kg", models: 1 }],
    },
  ];
  const selected = series.find((item) => item.id === selectedSeries) || series[0];
  const statusClass = (type) => "matrix-status matrix-status-" + type;

  return (
    <main className="workspace gantt-workspace vertical-gantt">
      <header className="topbar">
        <div className="breadcrumbs"><button><CaretLeft size={17} /></button><span>生产与发布</span><b>/</b><strong>钓具系列甘特图</strong></div>
        <button className="search"><MagnifyingGlass size={16} />搜索系列 / SKU / Model <kbd>⌘ K</kbd></button>
      </header>

      <div className="gantt-heading">
        <div>
          <h1>钓具系列甘特图</h1>
          <p>按品质、类型和离散重量规划 Series → SKU 抽屉 → Model；覆盖区间不代表连续插值。</p>
        </div>
        <div className="gantt-actions">
          <button className="filter-btn">品质（4）<CaretDown /></button>
          <button className="filter-btn">类型（2）<CaretDown /></button>
          <button className="filter-btn">状态（全部）<CaretDown /></button>
          <button className="btn primary" onClick={onCandidate}><Sparkle size={16} />生成 Model 候选</button>
          <button className="btn solid" onClick={onCreate}><Plus size={16} />新建系列</button>
        </div>
      </div>

      <div className="vertical-notice"><Warning size={16} />纵向重量段是可配置的规划坐标；Series 覆盖块连接的是离散 SKU 节点，不表示区间内连续插值。</div>

      <section className="series-matrix" aria-label="系列覆盖矩阵">
        <div className="matrix-axis-head">
          <span>重量段 <Gear size={14} /></span>
        </div>
        <div className="quality-groups">
          {qualities.map((quality) => <div key={quality.name} className={quality.className}>{quality.name}<small>品质</small></div>)}
        </div>
        <div className="type-groups">
          {lanes.map((lane, index) => <div key={index}>{lane}</div>)}
        </div>
        <div className="matrix-body">
          {weightBands.map((band, row) => (
            <div key={band.name} className="weight-band-label" style={{ gridRow: row + 1 }}>
              <strong>{band.name}</strong><span>{band.range}</span>
            </div>
          ))}
          {weightBands.flatMap((band, row) => lanes.map((lane, laneIndex) => (
            <div key={band.name + laneIndex} className="matrix-grid-cell" style={{ gridRow: row + 1, gridColumn: laneIndex + 2 }}></div>
          )))}
          {series.map((item) => (
            <button
              key={item.id}
              className={"series-cover " + (selectedSeries === item.id ? "selected" : "")}
              style={{ "--lane": item.lane, "--start": item.start, "--span": item.span, "--series-color": item.color }}
              onClick={() => setSelectedSeries(item.id)}
              aria-label={item.name + "，" + item.quality + "品质，" + item.type}
            >
              <span className="series-cover-title"><strong>{item.name}</strong><small>{item.concept}</small></span>
              <span className="series-node-spine">
                {item.nodes.map((node) => (
                  <span className="series-matrix-node" key={node.weight}>
                    <i></i><b>{node.weight}</b><small>{node.models} Models</small>
                  </span>
                ))}
              </span>
              <span className={statusClass(item.statusType)}>{item.status}</span>
            </button>
          ))}
        </div>
      </section>

      <section className="matrix-legend">
        <div><strong>图例说明</strong></div>
        <p><span className="legend-cover"></span><b>系列覆盖块</b><small>同一系列在品质/类型下的覆盖范围</small></p>
        <p><span className="legend-node"></span><b>离散 SKU 节点</b><small>每个节点代表一个独立 SKU 抽屉</small></p>
        <p><span className="legend-count">x Models</span><b>Model 数量</b><small>该 SKU 下可购买 Model 的数量</small></p>
        <p><Status type="success">不变量通过</Status><b>状态标签</b><small>文字与颜色同时表达</small></p>
      </section>

      <section className="selected-series-bar">
        <div className="selected-summary" style={{ "--series-color": selected.color }}>
          <span className="selected-stripe"></span>
          <div><small>已选择系列</small><strong>{selected.name}</strong><Status type={selected.statusType === "success" ? "success" : selected.statusType === "danger" ? "danger" : "review"}>{selected.status}</Status><p>{selected.concept} · {selected.type}　品质：{selected.quality}</p></div>
        </div>
        <div><small>覆盖 SKU（{selected.nodes.length} 个）</small><p>{selected.nodes.map((node) => <span key={node.weight}>{node.weight} · {node.models} Models</span>)}</p></div>
        <div><small>规则检查</small><p>不变量：{selected.statusType === "danger" ? "失败 2 项" : "通过 12 项"}　<a>查看详情</a></p><p>规则版本：v3.9</p></div>
        <div className="selected-actions"><small>快速操作</small><p><button onClick={selected.id === "qinglu" ? onOpenModel : () => onToast("该系列的 SKU 抽屉已进入原型占位。")}>打开 SKU 抽屉</button><button onClick={onCandidate}>查看 Model 候选</button><button>更多操作 <CaretDown /></button></p></div>
      </section>
    </main>
  );
}

export function App() {
  const [view, setView] = useState("matrix");
  const [drawerOpen, setDrawerOpen] = useState(true);
  const [drawerMode, setDrawerMode] = useState("preview");
  const [toast, setToast] = useState("");
  const [patchCreated, setPatchCreated] = useState(false);

  useEffect(() => {
    const handler = (event) => {
      if (event.key === "Escape") setDrawerOpen(false);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 3200);
    return () => clearTimeout(timer);
  }, [toast]);

  const notify = (message) => {
    setToast(message);
    if (message.includes("Patch 草稿")) setPatchCreated(true);
  };

  const navigate = (id) => {
    if (id === "gantt") {
      setView("gantt");
      setDrawerOpen(false);
      return;
    }
    setToast("该页面在本轮原型中以入口占位，核心流程仍可从甘特图继续。");
  };

  const openModel = () => {
    setView("matrix");
    setDrawerOpen(true);
    setDrawerMode("preview");
  };

  return (
    <AppShell activeView="gantt" onNavigate={navigate}>
      {view === "gantt" ? (
        <GanttWorkspace onOpenModel={openModel} onCandidate={() => notify("已生成 3 个 Model 候选，未写入系列。")} onCreate={() => notify("已创建系列草稿，尚未进入审核。")} onToast={notify} />
      ) : (
        <MatrixWorkspace
          onOpenDrawer={() => { setDrawerOpen(true); setDrawerMode("preview"); }}
          onOpenAI={() => { setDrawerOpen(true); setDrawerMode("ai"); }}
          onCandidate={() => notify("已生成 3 个 Model 候选，等待人工选择。")}
          onBackGantt={() => { setView("gantt"); setDrawerOpen(false); }}
        />
      )}
      <PreviewDrawer open={drawerOpen} mode={drawerMode} setMode={setDrawerMode} onClose={() => setDrawerOpen(false)} onToast={notify} patchCreated={patchCreated} />
      {toast ? <div className="toast"><Check size={17} weight="bold" />{toast}</div> : null}
    </AppShell>
  );
}
