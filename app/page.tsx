import type { Metadata } from "next";
import { Workbench } from "./Workbench";
import { createSeedState } from "@/lib/seed";
import { isLocalSessionEditorEnabled } from "@/lib/local-session-feature";
import { LocalSessionWorkbench } from "./LocalSessionWorkbench";
import "./local-session-workbench.css";

export const metadata: Metadata = {
  title: "钓具配置工坊",
  description: "淡水路亚杆、轮、线的分层规则、词条品质、Series、SKU 抽屉与 Model 配置工作台。",
};

export default function Home() {
  if (isLocalSessionEditorEnabled(
    process.env.TACKLE_FORGER_LOCAL_SESSION_EDITOR_ENABLED,
  )) {
    return <LocalSessionWorkbench />;
  }
  return <Workbench initialState={createSeedState({ mode: "production" })} />;
}
