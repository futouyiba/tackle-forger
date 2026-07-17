import Link from "next/link";
import { AppShell } from "@/components/AppShell";

const metrics = [
  { label: "活跃模板", value: "12", detail: "4 种钓法 · 12 个重量段", tone: "emerald" },
  { label: "草稿候选", value: "186", detail: "最新规则层运行后 +48", tone: "cyan" },
  { label: "待评审", value: "7", detail: "3 条强度 · 4 条覆盖", tone: "amber" },
  { label: "规则提案", value: "3", detail: "等待管理员审批", tone: "violet" },
];

const pipeline = [
  ["01", "标准模板", "钓法 × 大重量段的中性基准", "12 个模板"],
  ["02", "定位 / 类型 / 材质", "远投、精准、结构、线族", "18 个选项"],
  ["03", "技术", "碳布、耐久、传动工艺", "11 个选项"],
  ["04", "特殊系列", "系列身份与专属词条", "8 个系列"],
  ["05", "功能 / 性能", "三级特化包", "39 个选项"],
  ["06", "特殊规则", "高层数可浮动或覆盖低层", "4 个层"],
  ["07", "手工筛选", "精调、对比、采纳或驳回", "7 条待处理"],
  ["08", "规则学习闭环", "把反复精调固化为提案", "3 条提案"],
];

const recent = [
  { sku: "FW-24", series: "深流·远投", template: "T08 · 超重", affixes: ["远投校准", "抗冲击", "低风阻"], score: "17.2", quality: "紫", status: "待评审" },
  { sku: "FW-25", series: "深流·远投", template: "T09 · 巨物 I", affixes: ["远投校准", "强化骨架"], score: "12.0", quality: "紫", status: "待评审" },
  { sku: "FW-30", series: "深渊·征服", template: "T10 · 巨物 II", affixes: ["抗冲击", "超耐磨", "散热传动"], score: "22.4", quality: "金", status: "待评审" },
  { sku: "FW-31", series: "深渊·征服", template: "T11 · 巨物 III", affixes: ["抗冲击", "特种碳纤维", "缓冲防脱"], score: "25.1", quality: "金", status: "待评审" },
];

export default function Home() {
  return (
    <AppShell
      title="装备生成总览"
      subtitle="设计控制中心"
      actions={<><button className="button secondary">导入工作簿</button><button className="button primary">生成候选</button></>}
    >
      <section className="metrics">
        {metrics.map((metric) => (
          <article className={`metric ${metric.tone}`} key={metric.label}>
            <span>{metric.label}</span>
            <strong>{metric.value}</strong>
            <small>{metric.detail}</small>
          </article>
        ))}
      </section>

      <section className="panel pipeline-panel">
        <div className="panel-heading">
          <div><span>可配置管线</span><h2>分层生成循环</h2></div>
          <Link className="text-button" href="/layers">管理规则层 →</Link>
        </div>
        <div className="pipeline-grid">
          {pipeline.map(([number, title, description, meta], index) => (
            <article className="pipeline-step" key={number}>
              <div className="step-number">{number}</div>
              <div><h3>{title}</h3><p>{description}</p><small>{meta}</small></div>
              {index < pipeline.length - 1 && <span className="step-arrow">→</span>}
            </article>
          ))}
        </div>
      </section>

      <div className="two-column">
        <section className="panel affix-panel">
          <div className="panel-heading">
            <div><span>达成品质</span><h2>词条评分模型</h2></div>
            <Link className="text-button" href="/quality">编辑评分 →</Link>
          </div>
          <div className="quality-scale">
            <div className="quality-bar"><i className="green" /><i className="blue" /><i className="purple" /><i className="gold" /></div>
            <div className="quality-labels"><span>绿 0–4.9</span><span>蓝 5–9.9</span><span>紫 10–19.9</span><span>金 20+</span></div>
          </div>
          <div className="affix-examples">
            <div><span className="affix-icon">+10</span><div><strong>直接属性词条</strong><p>抛投精度 +10 · 价值 3 分</p></div></div>
            <div><span className="affix-icon passive">◆</span><div><strong>被动技能词条</strong><p>抗冲击 · 价值 6 分</p></div></div>
          </div>
          <div className="formula-line"><code>品质 = 聚合(系列词条 + SKU 词条)</code><span>SUM · v1</span></div>
        </section>

        <section className="panel feedback-panel">
          <div className="panel-heading"><div><span>反馈闭环</span><h2>手工精调 → 可复用规则</h2></div></div>
          <ol>
            <li><b>1</b><div><strong>记录精调</strong><p>修改前后、原因、标签、评审人</p></div><span>48 次调整</span></li>
            <li><b>2</b><div><strong>发现重复模式</strong><p>按层、参数、上下文聚类</p></div><span>6 个簇</span></li>
            <li><b>3</b><div><strong>模拟提案</strong><p>预览影响与新增校验失败</p></div><span>3 条就绪</span></li>
            <li><b>4</b><div><strong>批准新规则版本</strong><p>安全重算依赖候选</p></div><span>仅管理员</span></li>
          </ol>
        </section>
      </div>

      <section className="panel table-panel">
        <div className="panel-heading">
          <div><span>近期产出</span><h2>已生成 SKU 候选</h2></div>
          <div className="table-actions"><button className="button ghost">对比</button><Link className="button secondary" href="/skus">打开 SKU 表</Link></div>
        </div>
        <div className="data-table">
          <div className="data-row header"><span>SKU</span><span>系列</span><span>模板</span><span>词条</span><span>评分</span><span>品质</span><span>状态</span></div>
          {recent.map((item) => (
            <div className="data-row" key={item.sku}>
              <strong>{item.sku}</strong><span>{item.series}</span><span>{item.template}</span>
              <span className="tags">{item.affixes.map((affix) => <i key={affix}>{affix}</i>)}</span>
              <strong>{item.score}</strong><span className={`quality ${item.quality === "金" ? "gold" : "purple"}`}>{item.quality}</span>
              <span className={`status ${item.status === "待评审" ? "review" : "ready"}`}>{item.status}</span>
            </div>
          ))}
        </div>
      </section>
    </AppShell>
  );
}
