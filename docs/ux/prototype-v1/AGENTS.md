# Prototype Instructions

Run the local server yourself and open the preview in the browser available to this environment. Do not give the user server-start instructions when you can run it.

Before making substantial visual changes, use the Product Design plugin's `get-context` skill when the visual source is unclear or no longer matches the current goal. When the user gives durable prototype-specific design feedback, preferences, or decisions, record them in `AGENTS.md`.

When implementing from a selected generated mock, treat that image as the source of truth for layout, component anatomy, density, spacing, color, typography, visible content, and hierarchy.

## Locked direction

- Use the high-density data cockpit as the primary frame.
- The primary navigation label is 钓具系列甘特图; candidate generation is a secondary action named 生成 Model 候选.
- Model preview slides in from the right and includes a configurable five-axis radar chart.
- AI评估与建议 is advisory only. It may preview changes, create Patch drafts, or create Feishu proposals, but must never override deterministic validation or publish automatically.

- The 钓具系列甘特图 is rotated 90 degrees from the earlier timeline: vertical axis = configurable weight bands; horizontal axis = quality C/B/A/S then type lanes. Series are graphical coverage blocks containing discrete SKU nodes. Coverage never implies interpolation.
