import { NextRequest, NextResponse } from "next/server";
import { listRevisions, loadRevision } from "@/lib/storage";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const revision = request.nextUrl.searchParams.get("revision");
  if (revision) {
    const state = await loadRevision(Number(revision));
    if (!state) return NextResponse.json({ error: "找不到该版本。" }, { status: 404 });
    return NextResponse.json({ state, revision: Number(revision) });
  }
  return NextResponse.json({ revisions: await listRevisions() });
}
