import { NextResponse } from "next/server";
import { parseCompatibleWorkbook } from "@tackle-forger/excel";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const file = formData.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "未收到文件，请上传 .xlsx" }, { status: 400 });
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const parsed = await parseCompatibleWorkbook(bytes);

    const sheets = parsed.sheets.map((sheet) => ({
      name: sheet.name,
      columns: sheet.headers.length,
      rows: sheet.rows.length,
      headers: sheet.headers.slice(0, 8),
    }));

    const totals = sheets.reduce((accumulator, sheet) => ({
      rows: accumulator.rows + sheet.rows,
      columns: Math.max(accumulator.columns, sheet.columns),
    }), { rows: 0, columns: 0 });

    return NextResponse.json({
      fileName: file.name,
      sheetCount: sheets.length,
      totals,
      sheets,
      metadata: parsed.metadata ?? null,
      hasMetadata: Boolean(parsed.metadata),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "未知错误";
    return NextResponse.json({ error: `解析失败：${message}` }, { status: 500 });
  }
}
