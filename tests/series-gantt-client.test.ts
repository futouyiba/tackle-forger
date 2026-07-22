import assert from "node:assert/strict";
import test from "node:test";
import {
  fetchSeriesGanttList,
  fetchSeriesGanttModels,
  SeriesGanttRequestError,
  type SeriesGanttListResponse,
  type SeriesGanttModelResponse,
} from "../lib/series-gantt-contract";

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("甘特客户端遇到409游标过期会保留筛选并从第一页恢复", async () => {
  const requests: string[] = [];
  const recoveredPayload = {
    revision: 12,
    query: { text: "青芦", pageSize: 1 },
    blocks: [],
    page: { totalVisible: 0, pageSize: 1 },
    facets: { weights: [], typeIds: [], issueCodes: [], ruleSetVersions: [] },
    actions: [],
  } satisfies SeriesGanttListResponse;
  const fetcher = async (input: RequestInfo | URL) => {
    requests.push(String(input));
    return requests.length === 1
      ? jsonResponse({ code: "SERIES_GANTT_CURSOR_STALE", error: "stale" }, 409)
      : jsonResponse(recoveredPayload);
  };
  const result = await fetchSeriesGanttList({
    query: { text: "青芦", pageSize: 1 },
    cursor: "gantt.11.1.hash",
    anchorSeriesId: "series:selected",
    fetcher,
  });
  assert.equal(result.recoveredFromStaleCursor, true);
  assert.equal(result.payload.revision, 12);
  assert.match(requests[0]!, /q=%E9%9D%92%E8%8A%A6/);
  assert.match(requests[0]!, /cursor=/);
  assert.doesNotMatch(requests[1]!, /cursor=/);
  assert.match(requests[1]!, /q=%E9%9D%92%E8%8A%A6/);
  assert.match(requests[0]!, /anchorSeriesId=series%3Aselected/);
  assert.match(requests[1]!, /anchorSeriesId=series%3Aselected/);
});

test("甘特客户端不会把非游标409静默恢复", async () => {
  await assert.rejects(
    fetchSeriesGanttModels({
      skuId: "sku:1",
      cursor: "cursor",
      fetcher: async () => jsonResponse({ code: "OTHER_CONFLICT", error: "conflict" }, 409),
    }),
    (error: unknown) => error instanceof SeriesGanttRequestError && error.status === 409 && error.code === "OTHER_CONFLICT",
  );
});

test("Model按需加载只消费服务端返回的可见对象和游标", async () => {
  const payload = {
    revision: 4,
    skuId: "sku:visible",
    models: [{ id: "model:visible" }],
    page: { nextCursor: "next", totalVisible: 2, pageSize: 1 },
  } as unknown as SeriesGanttModelResponse;
  const { payload: result } = await fetchSeriesGanttModels({
    skuId: "sku:visible",
    pageSize: 1,
    fetcher: async () => jsonResponse(payload),
  });
  assert.deepEqual(result.models.map((model) => model.id), ["model:visible"]);
  assert.equal(result.page.nextCursor, "next");
  assert.equal(result.page.totalVisible, 2);
});
