import { NextResponse } from "next/server";
import { createCompatibleWorkbook, type WorkbookMetadata } from "@tackle-forger/excel";

export const dynamic = "force-dynamic";

export async function GET() {
  const metadata: WorkbookMetadata = {
    schemaVersion: 1,
    calculationVersion: 1,
    exportedAt: new Date().toISOString(),
    parameterMappings: {
      "rod.maxFishWeight": "杆最大钓重", "rod.length": "杆长", "reel.maxPull": "轮拉力",
      "line.maxPull": "线拉力", "rod.distanceCoeff": "抛投能力系数",
    },
    ruleVersions: { L2: 3, L3: 2, L4: 2, L5: 4, L6: 3 },
  };

  const buffer = await createCompatibleWorkbook(metadata);
  return new NextResponse(Buffer.from(buffer), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="tackle-forger-export-${Date.now()}.xlsx"`,
      "Cache-Control": "no-store",
    },
  });
}
