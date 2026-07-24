import type {
  FiveAxisVertexCandidateSemanticKey,
  FiveAxisVertexGroupKey,
} from "./types";

export const FIVE_AXIS_HASH_INPUT_SCHEMA_VERSION =
  "five-axis-hash-input/v1" as const;

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

function assertValidUnicode(value: string, field: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new Error(`${field} 含非法 Unicode 高代理项。`);
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new Error(`${field} 含非法 Unicode 低代理项。`);
    }
  }
}

function assertExactKeys(
  value: object,
  expectedKeys: string[],
  path: string,
): void {
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (
    actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])
  ) {
    throw new Error(`${path} 字段必须严格为 ${expected.join("、")}。`);
  }
}

function canonicalize(value: JsonValue, path: string): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") {
    assertValidUnicode(value, path);
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${path} 必须是有限数值。`);
    if (!Number.isSafeInteger(value)) {
      throw new Error(`${path} 的 JSON 数值必须是安全整数；业务小数必须使用 CanonicalDecimal。`);
    }
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry, index) => canonicalize(entry, `${path}[${index}]`)).join(",")}]`;
  }
  if (typeof value !== "object") {
    throw new Error(`${path} 不是 five-axis-hash-input/v1 支持的 JSON 值。`);
  }
  const object = value as Record<string, JsonValue>;
  const keys = Object.keys(object).sort();
  return `{${keys.map((key) => {
    assertValidUnicode(key, `${path} 的字段名`);
    const entry = object[key];
    if (entry === undefined) throw new Error(`${path}.${key} 不得为 undefined。`);
    return `${JSON.stringify(key)}:${canonicalize(entry, `${path}.${key}`)}`;
  }).join(",")}}`;
}

export function canonicalJsonBytes(value: JsonValue): Uint8Array {
  return new TextEncoder().encode(canonicalize(value, "$"));
}

function rotateRight(value: number, count: number): number {
  return (value >>> count) | (value << (32 - count));
}

export function sha256Hex(bytes: Uint8Array): string {
  const initial = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ];
  const constants = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  const bitLength = bytes.length * 8;
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000), false);
  view.setUint32(paddedLength - 4, bitLength >>> 0, false);

  const hash = [...initial];
  const words = new Uint32Array(64);
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      words[index] = view.getUint32(offset + index * 4, false);
    }
    for (let index = 16; index < 64; index += 1) {
      const s0 = rotateRight(words[index - 15], 7)
        ^ rotateRight(words[index - 15], 18)
        ^ (words[index - 15] >>> 3);
      const s1 = rotateRight(words[index - 2], 17)
        ^ rotateRight(words[index - 2], 19)
        ^ (words[index - 2] >>> 10);
      words[index] = (words[index - 16] + s0 + words[index - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = hash;
    for (let index = 0; index < 64; index += 1) {
      const s1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choice = (e & f) ^ (~e & g);
      const temp1 = (h + s1 + choice + constants[index] + words[index]) >>> 0;
      const s0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    hash[0] = (hash[0] + a) >>> 0;
    hash[1] = (hash[1] + b) >>> 0;
    hash[2] = (hash[2] + c) >>> 0;
    hash[3] = (hash[3] + d) >>> 0;
    hash[4] = (hash[4] + e) >>> 0;
    hash[5] = (hash[5] + f) >>> 0;
    hash[6] = (hash[6] + g) >>> 0;
    hash[7] = (hash[7] + h) >>> 0;
  }
  return hash.map((value) => value.toString(16).padStart(8, "0")).join("");
}

export function hashCanonicalJson(value: JsonValue): string {
  return sha256Hex(canonicalJsonBytes(value));
}

export function canonicalDecimal(input: string): string {
  assertValidUnicode(input, "CanonicalDecimal");
  const match = /^([+-]?)(\d+)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(input);
  if (!match) throw new Error(`非法 CanonicalDecimal：${input}`);
  const negative = match[1] === "-";
  const fraction = match[3] ?? "";
  const exponent = Number.parseInt(match[4] ?? "0", 10);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 10_000) {
    throw new Error("CanonicalDecimal 指数超出安全范围。");
  }
  const combinedDigits = `${match[2]}${fraction}`;
  const leadingZeroCount = combinedDigits.length - combinedDigits.replace(/^0+/, "").length;
  const digits = combinedDigits.slice(leadingZeroCount);
  if (!digits) return "0";
  const decimalPosition = match[2].length + exponent - leadingZeroCount;
  let normalized: string;
  if (decimalPosition <= 0) {
    normalized = `0.${"0".repeat(-decimalPosition)}${digits}`;
  } else if (decimalPosition >= digits.length) {
    normalized = `${digits}${"0".repeat(decimalPosition - digits.length)}`;
  } else {
    normalized = `${digits.slice(0, decimalPosition)}.${digits.slice(decimalPosition)}`;
  }
  const [integerPart, fractionPart = ""] = normalized.split(".");
  const integer = integerPart.replace(/^0+(?=\d)/, "") || "0";
  const trimmedFraction = fractionPart.replace(/0+$/, "");
  const result = trimmedFraction ? `${integer}.${trimmedFraction}` : integer;
  return negative && result !== "0" ? `-${result}` : result;
}

export function compareUnsignedUtf8(left: string, right: string): number {
  assertValidUnicode(left, "排序键");
  assertValidUnicode(right, "排序键");
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  for (let index = 0; index < Math.min(leftBytes.length, rightBytes.length); index += 1) {
    if (leftBytes[index] !== rightBytes[index]) return leftBytes[index] - rightBytes[index];
  }
  return leftBytes.length - rightBytes.length;
}

function compareKey(
  left: FiveAxisVertexCandidateSemanticKey,
  right: FiveAxisVertexCandidateSemanticKey,
): number {
  return compareUnsignedUtf8(left.modelId, right.modelId)
    || compareUnsignedUtf8(left.componentEntityId, right.componentEntityId)
    || compareUnsignedUtf8(left.itemPartId, right.itemPartId);
}

function keyIdentity(key: FiveAxisVertexCandidateSemanticKey): string {
  return canonicalize(key as unknown as JsonValue, "$.candidateSemanticKey");
}

function assertHash(value: string, field: string): void {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${field} 必须是 SHA-256 小写十六进制。`);
  }
}

function groupKeyJson(groupKey: FiveAxisVertexGroupKey): JsonValue {
  assertExactKeys(
    groupKey,
    [
      "weightBandId",
      "weightBandPolicyVersion",
      "fiveAxisDefinitionId",
      "fiveAxisDefinitionVersion",
      "fiveAxisRuleVersion",
    ],
    "vertexGroupKey",
  );
  return {
    weightBandId: groupKey.weightBandId,
    weightBandPolicyVersion: groupKey.weightBandPolicyVersion,
    fiveAxisDefinitionId: groupKey.fiveAxisDefinitionId,
    fiveAxisDefinitionVersion: groupKey.fiveAxisDefinitionVersion,
    fiveAxisRuleVersion: groupKey.fiveAxisRuleVersion,
  };
}

export function hashCandidateSemanticInput(input: {
  finalPanelHash: string;
  modelFinalPullKg: string;
  directInputs: Array<{
    axisId: string;
    parameterKey: string;
    rawValue: string;
    unit: string;
    inputHash: string;
    axisOrder?: number;
  }>;
}): { canonicalBytes: Uint8Array; hash: string } {
  assertExactKeys(input, ["finalPanelHash", "modelFinalPullKg", "directInputs"], "candidate_semantic_input");
  assertHash(input.finalPanelHash, "finalPanelHash");
  const directInputs = input.directInputs.map((entry) => {
    assertExactKeys(
      entry,
      entry.axisOrder === undefined
        ? ["axisId", "parameterKey", "rawValue", "unit", "inputHash"]
        : ["axisId", "parameterKey", "rawValue", "unit", "inputHash", "axisOrder"],
      "candidate_semantic_input.directInputs[]",
    );
    assertHash(entry.inputHash, "directInputs.inputHash");
    return {
      axisId: entry.axisId,
      parameterKey: entry.parameterKey,
      rawValue: canonicalDecimal(entry.rawValue),
      unit: entry.unit,
      inputHash: entry.inputHash,
      axisOrder: entry.axisOrder ?? Number.MAX_SAFE_INTEGER,
    };
  }).sort((left, right) =>
    left.axisOrder - right.axisOrder
    || compareUnsignedUtf8(left.parameterKey, right.parameterKey)
    || compareUnsignedUtf8(left.unit, right.unit)
    || compareUnsignedUtf8(left.inputHash, right.inputHash));
  const seen = new Set<string>();
  for (const entry of directInputs) {
    const identity = `${entry.axisId}\u0000${entry.parameterKey}\u0000${entry.unit}\u0000${entry.inputHash}`;
    if (seen.has(identity)) throw new Error("directInputs 含重复排序键。");
    seen.add(identity);
  }
  const envelope: JsonValue = {
    schemaVersion: FIVE_AXIS_HASH_INPUT_SCHEMA_VERSION,
    kind: "candidate_semantic_input",
    finalPanelHash: input.finalPanelHash,
    modelFinalPullKg: canonicalDecimal(input.modelFinalPullKg),
    directInputs: directInputs.map((entry) => ({
      axisId: entry.axisId,
      parameterKey: entry.parameterKey,
      rawValue: entry.rawValue,
      unit: entry.unit,
      inputHash: entry.inputHash,
    })),
  };
  const canonicalBytes = canonicalJsonBytes(envelope);
  return { canonicalBytes, hash: sha256Hex(canonicalBytes) };
}

export function hashCandidateSet(input: {
  vertexGroupKey: FiveAxisVertexGroupKey;
  candidates: Array<{
    key: FiveAxisVertexCandidateSemanticKey;
    semanticInputHash: string;
  }>;
}): string {
  assertExactKeys(input, ["vertexGroupKey", "candidates"], "candidate_set");
  const candidates = [...input.candidates].sort((left, right) => compareKey(left.key, right.key));
  const seen = new Set<string>();
  for (const candidate of candidates) {
    assertExactKeys(candidate, ["key", "semanticInputHash"], "candidate_set.candidates[]");
    assertExactKeys(candidate.key, ["modelId", "componentEntityId", "itemPartId"], "candidate_set.candidates[].key");
    assertHash(candidate.semanticInputHash, "semanticInputHash");
    const identity = keyIdentity(candidate.key);
    if (seen.has(identity)) throw new Error("candidate_set 含重复 candidateSemanticKey。");
    seen.add(identity);
  }
  return hashCanonicalJson({
    schemaVersion: FIVE_AXIS_HASH_INPUT_SCHEMA_VERSION,
    kind: "candidate_set",
    vertexGroupKey: groupKeyJson(input.vertexGroupKey),
    candidates: candidates.map((candidate) => ({
      key: candidate.key as unknown as JsonValue,
      semanticInputHash: candidate.semanticInputHash,
    })),
  });
}

export function hashCandidateEvidence(input: {
  vertexGroupKey: FiveAxisVertexGroupKey;
  candidates: Array<{
    key: FiveAxisVertexCandidateSemanticKey;
    snapshotId: string;
    modelRevisionId: string;
    semanticInputHash: string;
  }>;
}): string {
  assertExactKeys(input, ["vertexGroupKey", "candidates"], "candidate_evidence");
  const candidates = [...input.candidates].sort((left, right) => compareKey(left.key, right.key));
  const seen = new Set<string>();
  for (const candidate of candidates) {
    assertExactKeys(
      candidate,
      ["key", "snapshotId", "modelRevisionId", "semanticInputHash"],
      "candidate_evidence.candidates[]",
    );
    assertExactKeys(candidate.key, ["modelId", "componentEntityId", "itemPartId"], "candidate_evidence.candidates[].key");
    assertHash(candidate.semanticInputHash, "semanticInputHash");
    const identity = keyIdentity(candidate.key);
    if (seen.has(identity)) throw new Error("candidate_evidence 含重复 candidateSemanticKey。");
    seen.add(identity);
  }
  return hashCanonicalJson({
    schemaVersion: FIVE_AXIS_HASH_INPUT_SCHEMA_VERSION,
    kind: "candidate_evidence",
    vertexGroupKey: groupKeyJson(input.vertexGroupKey),
    candidates: candidates.map((candidate) => ({
      key: candidate.key as unknown as JsonValue,
      snapshotId: candidate.snapshotId,
      modelRevisionId: candidate.modelRevisionId,
      semanticInputHash: candidate.semanticInputHash,
    })),
  });
}

export function hashVertexSet(input: {
  vertexGroupKey: FiveAxisVertexGroupKey;
  candidateSetHash: string;
  vertices: Array<{
    axisId: string;
    vertexRawValue: string;
    vertexSelectorId: string;
    vertexSelectorVersion: string;
    axisOrder?: number;
  }>;
}): string {
  assertExactKeys(input, ["vertexGroupKey", "candidateSetHash", "vertices"], "vertex_set");
  assertHash(input.candidateSetHash, "candidateSetHash");
  const vertices = input.vertices.map((vertex) => {
    assertExactKeys(
      vertex,
      vertex.axisOrder === undefined
        ? ["axisId", "vertexRawValue", "vertexSelectorId", "vertexSelectorVersion"]
        : ["axisId", "vertexRawValue", "vertexSelectorId", "vertexSelectorVersion", "axisOrder"],
      "vertex_set.vertices[]",
    );
    return {
      ...vertex,
      vertexRawValue: canonicalDecimal(vertex.vertexRawValue),
      axisOrder: vertex.axisOrder ?? Number.MAX_SAFE_INTEGER,
    };
  }).sort((left, right) => left.axisOrder - right.axisOrder);
  const seen = new Set<string>();
  for (const vertex of vertices) {
    if (seen.has(vertex.axisId)) throw new Error("vertex_set 含重复 axisId。");
    seen.add(vertex.axisId);
  }
  return hashCanonicalJson({
    schemaVersion: FIVE_AXIS_HASH_INPUT_SCHEMA_VERSION,
    kind: "vertex_set",
    vertexGroupKey: groupKeyJson(input.vertexGroupKey),
    candidateSetHash: input.candidateSetHash,
    vertices: vertices.map((vertex) => ({
      axisId: vertex.axisId,
      vertexRawValue: vertex.vertexRawValue,
      vertexSelectorId: vertex.vertexSelectorId,
      vertexSelectorVersion: vertex.vertexSelectorVersion,
    })),
  });
}

export function hashProjectionReferenceSet(input: {
  selectorVersion: "projection-reference/current-sku-frozen-match/v1";
  anchor: {
    baselineSnapshotId: string;
    seriesId: string;
    skuId: string;
    skuRevisionId: string;
  };
  references: Array<{
    itemPartId: string;
    state: "available" | "missing" | "error";
    projectionMatchId: string | null;
    projectionMatchRevisionId: string | null;
    projectionId: string | null;
    projectionRevisionId: string | null;
  }>;
}): string {
  assertExactKeys(input, ["selectorVersion", "anchor", "references"], "projection_reference_set");
  assertExactKeys(
    input.anchor,
    ["baselineSnapshotId", "seriesId", "skuId", "skuRevisionId"],
    "projection_reference_set.anchor",
  );
  const expectedParts = ["part:rod", "part:reel", "part:line"];
  if (
    input.references.length !== expectedParts.length
    || input.references.some((reference, index) =>
      reference.itemPartId !== expectedParts[index])
  ) {
    throw new Error("projection_reference_set.references 必须按竿、轮、线恰好三项排列。");
  }
  for (const reference of input.references) {
    assertExactKeys(
      reference,
      [
        "itemPartId",
        "state",
        "projectionMatchId",
        "projectionMatchRevisionId",
        "projectionId",
        "projectionRevisionId",
      ],
      "projection_reference_set.references[]",
    );
    const identifiers = [
      reference.projectionMatchId,
      reference.projectionMatchRevisionId,
      reference.projectionId,
      reference.projectionRevisionId,
    ];
    if (reference.state === "available" && identifiers.some((value) => value === null)) {
      throw new Error("available 投影引用的四个身份字段不得为 null。");
    }
    if (reference.state !== "available" && identifiers.some((value) => value !== null)) {
      throw new Error("missing/error 投影引用的四个身份字段必须显式为 null。");
    }
  }
  return hashCanonicalJson({
    schemaVersion: FIVE_AXIS_HASH_INPUT_SCHEMA_VERSION,
    kind: "projection_reference_set",
    selectorVersion: input.selectorVersion,
    anchor: input.anchor,
    references: input.references,
  } as never);
}
