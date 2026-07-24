import type { Metadata } from "next";
import { Workbench } from "./Workbench";
import { createSeedState } from "@/lib/seed";

export const metadata: Metadata = {
  title: "钓具配置工坊",
  description: "淡水路亚杆、轮、线的分层规则、词条品质、Series、SKU 抽屉与 Model 配置工作台。",
};

export default function Home() {
  return <Workbench initialState={createSeedState({ mode: "production" })} />;
}
