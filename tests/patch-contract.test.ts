import assert from "node:assert/strict";
import test from "node:test";
import { jcsSha256Hex, jcsStringify, sha256Hex } from "../lib/canonical-json";
import { PATCH_SET_HASH_CONTRACT_VERSION, patchMirrorDetailKey, patchSetHashForReferences } from "../lib/patch-contract";

test("JCS/SHA-256 使用稳定规范 JSON 与标准摘要",()=>{
  assert.equal(sha256Hex("abc"),"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(jcsStringify({z:0,a:[true,null,"鱼"]}),'{"a":[true,null,"鱼"],"z":0}');
  assert.equal(jcsSha256Hex({a:1}),sha256Hex('{"a":1}'));
  assert.throws(()=>jcsStringify({invalid:undefined}),/undefined/);
});

test("PatchSet 与镜像键显式绑定 workspaceId 和类型",()=>{
  const refs=(workspaceId:string)=>[{
    workspaceId,patchId:"patch:1",patchRevision:1,orderedOperationIds:["op:1"],
  }];
  const first=patchSetHashForReferences(refs("workspace:a"),PATCH_SET_HASH_CONTRACT_VERSION);
  const second=patchSetHashForReferences(refs("workspace:b"),PATCH_SET_HASH_CONTRACT_VERSION);
  assert.equal(first.length,64);
  assert.notEqual(first,second);
  assert.notEqual(
    patchMirrorDetailKey({workspaceId:"workspace:a",patchId:"patch:1",patchRevision:1,operationId:"op:1"}),
    patchMirrorDetailKey({workspaceId:"workspace:b",patchId:"patch:1",patchRevision:1,operationId:"op:1"}),
  );
});
