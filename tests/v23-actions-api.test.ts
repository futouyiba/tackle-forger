import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { NextRequest } from "next/server";
import { POST as issueActionCommand } from "../app/api/action-commands/route";
import { POST as v23Actions } from "../app/api/v23/actions/route";
import { closeSqliteStorage } from "../lib/sqlite-storage";
import { loadWorkspaceState } from "../lib/storage";
import { v23ActionInputHash } from "../lib/v23-domain-actions";

const authHeaders = {
  "content-type": "application/json",
  "x-feishu-tenant-key": "tenant",
  "x-feishu-open-id": "v23-route-tester",
  "x-feishu-display-name": "v23-route-tester",
  "x-tf-proxy-secret": "v23-route-secret",
};

let root = "";
let databasePath = "";
const previousDatabasePath = process.env.WORKSPACE_DATABASE_PATH;

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "tackle-forger-v23-actions-"));
  databasePath = path.join(root, "workspace.sqlite");
  process.env.WORKSPACE_DATABASE_PATH = databasePath;
  process.env.FEISHU_TRUST_PROXY_HEADERS = "true";
  process.env.FEISHU_PROXY_SHARED_SECRET = "v23-route-secret";
  process.env.FEISHU_TENANT_KEY = "tenant";
});

after(async () => {
  await closeSqliteStorage(databasePath);
  await rm(root, { recursive: true, force: true });
  if (previousDatabasePath === undefined) delete process.env.WORKSPACE_DATABASE_PATH;
  else process.env.WORKSPACE_DATABASE_PATH = previousDatabasePath;
});

test("v23 write requires issued command and replay returns the one atomic result", { concurrency: false }, async () => {
  const current = await loadWorkspaceState();
  const unsigned = {
    expectedWorkspaceRevision: current.revision,
    seriesId: "series:v23-api",
    collectionId: null,
    name: "V23 API",
    concept: "Command boundary",
    parts: [{
      partId: "part:v23-api:rod",
      partType: "rod",
      fishingMethodId: "method:lure",
      materialTypeId: "material:carbon",
      functionProfileId: "function:cast",
      functionIntensity: 2,
      weightBandIds: ["band:light"],
      defaultEntryRefs: [],
      technologyRefs: [],
    }],
  };
  const payload = { ...unsigned, inputHash: v23ActionInputHash(unsigned) };
  const issuedResponse = await issueActionCommand(new NextRequest(
    "http://localhost/api/action-commands",
    {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        action: "create_series",
        idempotencyKey: "v23-api-create-series",
        payload,
      }),
    },
  ));
  assert.equal(issuedResponse.status, 200);
  const issued = await issuedResponse.json() as {
    actionId: string;
    commandPayloadRef: { payloadRefId: string };
  };
  const invocation = {
    actionId: issued.actionId,
    payloadRefId: issued.commandPayloadRef.payloadRefId,
  };
  const first = await v23Actions(new NextRequest("http://localhost/api/v23/actions", {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify(invocation),
  }));
  assert.equal(first.status, 200);
  const firstBody = await first.json() as { replayed?: boolean; revision?: number };
  assert.equal(firstBody.replayed, false);

  const replay = await v23Actions(new NextRequest("http://localhost/api/v23/actions", {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify(invocation),
  }));
  assert.equal(replay.status, 200);
  const replayBody = await replay.json() as { replayed?: boolean; revision?: number };
  assert.equal(replayBody.replayed, true);
  assert.equal(replayBody.revision, firstBody.revision);

  const readback = await loadWorkspaceState();
  assert.equal(
    readback.state.seriesDefinitions.filter((entry) => entry.id === "series:v23-api").length,
    1,
  );
  assert.deepEqual(
    readback.state.v23SeriesPartHeads.filter((entry) => entry.seriesId === "series:v23-api"),
    [{ seriesId: "series:v23-api", partId: "part:v23-api:rod", revision: 1 }],
  );
});

test("v23 preview is authenticated read-only and direct write payload is rejected", { concurrency: false }, async () => {
  const before = await loadWorkspaceState();
  const preview = await v23Actions(new NextRequest("http://localhost/api/v23/actions", {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({
      action: "preview_weight_band_skus",
      payload: {
        partId: "part:v23-api:rod",
        expectedPartRevision: 1,
        weightBandId: "band:light",
      },
    }),
  }));
  assert.equal(preview.status, 200);
  const afterPreview = await loadWorkspaceState();
  assert.equal(afterPreview.revision, before.revision);

  const bypass = await v23Actions(new NextRequest("http://localhost/api/v23/actions", {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({
      action: "create_sku",
      payload: {
        skuId: "sku:bypass",
        partId: "part:v23-api:rod",
      },
    }),
  }));
  assert.equal(bypass.status, 422);
  assert.equal(
    ((await bypass.json()) as { code?: string }).code,
    "ACTION_COMMAND_PAYLOAD_REQUIRED",
  );
  assert.equal((await loadWorkspaceState()).revision, before.revision);
});
