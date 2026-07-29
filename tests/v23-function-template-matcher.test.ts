import assert from "node:assert/strict";
import test from "node:test";
import { jcsSha256Hex } from "../lib/canonical-json";
import { matchV23FunctionTemplate } from "../lib/v23-function-template-matcher";

const key = { partType: "rod" as const, weightBandId: "w:1", fishingMethodId: "m", materialTypeId: "mat", functionProfileId: "f", functionIntensity: 2 as const };
const candidate = { ref: { templateId: "t", revisionId: "r1", contentHash: jcsSha256Hex("t") }, key, baselinePullKg: 5 };
test("v23 matcher only accepts one exact six-key template", () => {
  assert.equal(matchV23FunctionTemplate(key, [candidate]).status, "VALID");
  assert.equal(matchV23FunctionTemplate(key, []).status, "INVALID_NO_MATCH");
  assert.equal(matchV23FunctionTemplate(key, [candidate, { ...candidate, ref: { ...candidate.ref, templateId: "t2" } }]).status, "INVALID_AMBIGUOUS");
  assert.equal(matchV23FunctionTemplate({ ...key, weightBandId: "w:2" }, [candidate]).status, "INVALID_NO_MATCH");
});
