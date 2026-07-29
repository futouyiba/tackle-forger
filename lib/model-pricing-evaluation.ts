/**
 * ModelPricingEvaluation 权威引擎
 *
 * 客户端只提交输入引用（modelId、pricingPolicyRef、valueScore 等），
 * 服务端从冻结引用重算并验证。客户端不得自报价格、fingerprint 或确认。
 *
 * 本模块只做身份包装与验证；计算逻辑完全复用 pricing-policy.ts。
 */

import { deterministicHash } from "./rule-kernel";
import {
  acknowledgePriceWarning,
  calculatePricingTrial,
  pricingTrialOutputHash,
  type PricingPolicyDraft,
  type PricingPolicyVersion,
} from "./pricing-policy";
import { v23PricingInputFromAssessment } from "./v23-sku-quality";
import type {
  FunctionProfile,
  HistoricalModelPricingEvaluationInput,
  ModelPricingEvaluation,
  ModelPricingEvaluationInput,
  SeriesPartRevision,
  SkuDrawerRevision,
  V23ModelPricingEvaluationInput,
} from "./types";
import type { QualityValuePolicyDraft } from "./quality-value-policy";

// ─── 核心 ────────────────────────────────────────────────────────────

export interface ComputeEvaluationOptions {
  id: string;
  revision?: number;
  createdAt: string;
  createdBy: string;
}

/**
 * 从冻结输入和已发布策略创建新的不可变评估。
 * 客户端只能提供输入引用；价格、hash、状态完全由服务端重算。
 */
export interface V23ModelPricingEvaluationRequest {
  modelId: string;
  modelRevision: string;
  pricingPolicyRef: string;
  partId?: string;
  typeId?: string;
}

export interface V23ModelPricingEvaluationContext {
  sku: SkuDrawerRevision;
  part: SeriesPartRevision;
  qualityPolicy: QualityValuePolicyDraft;
  functionProfiles: readonly FunctionProfile[];
  canonicalFunctionProfiles: readonly FunctionProfile[];
}

/**
 * 当前 v23 入口：品质、分值和重量段只能从同一 SKU revision 的冻结评估构造。
 */
export function computeModelPricingEvaluation(
  request: V23ModelPricingEvaluationRequest,
  context: V23ModelPricingEvaluationContext,
  policy: PricingPolicyVersion,
  options: ComputeEvaluationOptions,
): ModelPricingEvaluation {
  if (request.pricingPolicyRef !== policy.id) {
    throw new Error("定价请求引用的策略与已解析策略不一致。");
  }
  const pricingInput = v23PricingInputFromAssessment({
    ...context,
    pricingPolicy: policy,
  });
  const input: V23ModelPricingEvaluationInput = {
    sourceKind: "V23_SKU_ASSESSMENT",
    modelId: request.modelId,
    modelRevision: request.modelRevision,
    pricingPolicyRef: request.pricingPolicyRef,
    partId: request.partId,
    typeId: request.typeId,
    skuId: context.sku.skuId,
    skuRevision: context.sku.revision,
    qualityAssessmentInputHash: pricingInput.qualityAssessmentInputHash,
    pricingWeightBandId: pricingInput.pricingWeightBandId,
    valueScore: pricingInput.finalValueScore,
    qualityId: pricingInput.qualityId,
  };
  return computeFrozenEvaluation(input, policy, options);
}

/**
 * 历史冻结记录的显式重放边界。调用者必须提供当时冻结的实际 qualityId；
 * 缺失时拒绝，绝不补默认品质。
 */
export function computeHistoricalModelPricingEvaluation(
  input: HistoricalModelPricingEvaluationInput,
  policy: PricingPolicyVersion,
  options: ComputeEvaluationOptions,
): ModelPricingEvaluation {
  if (!input.qualityId) {
    throw new Error("历史定价重放缺少冻结 qualityId。");
  }
  return computeFrozenEvaluation(input, policy, options);
}

function computeFrozenEvaluation(
  input: ModelPricingEvaluationInput,
  policy: PricingPolicyVersion,
  options: ComputeEvaluationOptions,
): ModelPricingEvaluation {
  if (policy.formalStatus !== "PUBLISHED") {
    return createNonFormalEvaluation(input, policy, options);
  }

  const trial = calculatePricingTrial({
    policy,
    partId: input.partId ?? "",
    typeId: input.typeId ?? "",
    pricingWeightBandId: input.pricingWeightBandId,
    valueScore: input.valueScore,
    qualityId: input.qualityId,
    modelRevisionId: `${input.modelId}@${input.modelRevision}`,
  });

  // 重算后验证 inputHash 一致性——服务端权威，不接受客户端自报
  const recomputedHash = pricingTrialOutputHash(trial, `${input.modelId}@${input.modelRevision}`);
  if (trial.inputHash !== recomputedHash) {
    throw new Error(`定价评估 inputHash 不一致：客户端提交与重算结果不匹配。`);
  }

  const contentHash = deterministicHash({
    input: { ...input },
    result: { ...trial, priceWarningAcknowledgement: undefined },
  });

  const status: ModelPricingEvaluation["status"] = trial.formal
    ? "ACKNOWLEDGED"
    : trial.priceUpperThresholdExceeded && trial.priceWarning?.state === "OPEN"
      ? "OPEN"
      : "NON_FORMAL";

  return {
    id: options.id,
    revision: options.revision ?? 1,
    modelId: input.modelId,
    modelRevision: input.modelRevision,
    pricingPolicyRef: input.pricingPolicyRef,
    input: { ...input },
    result: trial,
    contentHash,
    status,
    createdAt: options.createdAt,
    createdBy: options.createdBy,
  };
}

function createNonFormalEvaluation(
  input: ModelPricingEvaluationInput,
  policy: PricingPolicyVersion | PricingPolicyDraft,
  options: ComputeEvaluationOptions,
): ModelPricingEvaluation {
  const trial = calculatePricingTrial({
    policy,
    partId: input.partId ?? "",
    typeId: input.typeId ?? "",
    pricingWeightBandId: input.pricingWeightBandId,
    valueScore: input.valueScore,
    qualityId: input.qualityId,
    modelRevisionId: `${input.modelId}@${input.modelRevision}`,
  });

  const contentHash = deterministicHash({
    input: { ...input },
    result: { ...trial, priceWarningAcknowledgement: undefined },
  });

  return {
    id: options.id,
    revision: options.revision ?? 1,
    modelId: input.modelId,
    modelRevision: input.modelRevision,
    pricingPolicyRef: input.pricingPolicyRef,
    input: { ...input },
    result: trial,
    contentHash,
    status: "NON_FORMAL",
    createdAt: options.createdAt,
    createdBy: options.createdBy,
  };
}

// ─── 重算 ────────────────────────────────────────────────────────────

/**
 * 输入变化时创建新 revision，同时返回应标记为 STALE 的旧 revision（若存在）。
 * 调用方必须同时持久化 newEval 和 staleLegacy（若存在）。
 */
export function recomputeHistoricalModelPricingEvaluation(
  existing: ModelPricingEvaluation,
  newInput: HistoricalModelPricingEvaluationInput,
  policy: PricingPolicyVersion,
  options: Omit<ComputeEvaluationOptions, "id"> & { createdAt: string; createdBy: string },
): { newEval: ModelPricingEvaluation; staleLegacy?: ModelPricingEvaluation } {
  const newEval = computeHistoricalModelPricingEvaluation(newInput, policy, {
    id: existing.id,
    revision: existing.revision + 1,
    createdAt: options.createdAt,
    createdBy: options.createdBy,
  });

  const staleLegacy =
    existing.status === "ACKNOWLEDGED"
      ? { ...existing, status: "STALE" as const }
      : undefined;

  return { newEval, staleLegacy };
}

/**
 * 将旧 revision 标记为 STALE（输入变化后调用方负责持久化）。
 */
export function staleEvaluation(existing: ModelPricingEvaluation): ModelPricingEvaluation {
  if (existing.status !== "ACKNOWLEDGED") return existing;
  return { ...existing, status: "STALE" };
}

// ─── 验证 ────────────────────────────────────────────────────────────

export interface EvaluationValidationIssue {
  code: string;
  severity: "error" | "warning";
  message: string;
}

/**
 * 验证评估对当前策略和 Model revision 的完整性。
 * 用于 Snapshot 发布前的权威校验。
 */
export function validateModelPricingEvaluation(
  evaluation: ModelPricingEvaluation,
  policy: PricingPolicyVersion | undefined,
  modelRevision: string,
  currentContext?: V23ModelPricingEvaluationContext,
): EvaluationValidationIssue[] {
  const issues: EvaluationValidationIssue[] = [];

  // 策略必须仍为 PUBLISHED
  if (!policy || policy.id !== evaluation.pricingPolicyRef) {
    issues.push({
      code: "PRICING_POLICY_NOT_FOUND",
      severity: "error",
      message: `评估引用的定价策略 ${evaluation.pricingPolicyRef} 不存在或已变更。`,
    });
    return issues;
  }
  if (policy.formalStatus !== "PUBLISHED") {
    issues.push({
      code: "PRICING_POLICY_NOT_FORMAL",
      severity: "error",
      message: "评估引用的定价策略不再是 PUBLISHED 状态。",
    });
  }

  // modelRevision 必须匹配
  if (evaluation.modelRevision !== modelRevision) {
    issues.push({
      code: "MODEL_REVISION_MISMATCH",
      severity: "error",
      message: `评估绑定的 Model revision ${evaluation.modelRevision} 与当前 ${modelRevision} 不一致。`,
    });
  }

  if (evaluation.input.sourceKind === "V23_SKU_ASSESSMENT") {
    if (!currentContext) {
      issues.push({
        code: "SKU_QUALITY_EVIDENCE_REQUIRED",
        severity: "error",
        message: "v23 定价验证缺少当前 SKU revision 证据。",
      });
    } else {
      try {
        const pricingInput = v23PricingInputFromAssessment({
          ...currentContext,
          pricingPolicy: policy,
        });
        if (
          currentContext.sku.skuId !== evaluation.input.skuId
          || currentContext.sku.revision !== evaluation.input.skuRevision
          || pricingInput.qualityAssessmentInputHash !== evaluation.input.qualityAssessmentInputHash
          || pricingInput.qualityId !== evaluation.input.qualityId
          || pricingInput.finalValueScore !== evaluation.input.valueScore
          || pricingInput.pricingWeightBandId !== evaluation.input.pricingWeightBandId
        ) {
          issues.push({
            code: "SKU_QUALITY_EVIDENCE_STALE",
            severity: "error",
            message: "v23 定价绑定的 SKU 品质评估身份或内容已变化。",
          });
        }
      } catch {
        issues.push({
          code: "SKU_QUALITY_EVIDENCE_INVALID",
          severity: "error",
          message: "v23 定价绑定的 SKU 品质评估不完整或不可验证。",
        });
      }
    }
  }

  // 重算并验证 contentHash
  if (policy.formalStatus === "PUBLISHED") {
    const trial = calculatePricingTrial({
      policy,
      partId: evaluation.input.partId ?? "",
      typeId: evaluation.input.typeId ?? "",
      pricingWeightBandId: evaluation.input.pricingWeightBandId,
      valueScore: evaluation.input.valueScore,
      qualityId: evaluation.input.qualityId,
      modelRevisionId: `${evaluation.modelId}@${evaluation.modelRevision}`,
    });

    const recomputedHash = deterministicHash({
      input: { ...evaluation.input },
      result: { ...trial, priceWarningAcknowledgement: undefined },
    });

    if (recomputedHash !== evaluation.contentHash) {
      issues.push({
        code: "CONTENT_HASH_MISMATCH",
        severity: "error",
        message: "评估 contentHash 与服务端重算结果不一致。评估可能已被篡改或输入已变化。",
      });
    }

    // 验证 result 的核心价格字段一致性
    if (
      trial.repairPriceRaw !== evaluation.result.repairPriceRaw
      || trial.purchasePriceRaw !== evaluation.result.purchasePriceRaw
      || trial.purchasePriceRounded !== evaluation.result.purchasePriceRounded
      || trial.purchasePrice !== evaluation.result.purchasePrice
    ) {
      issues.push({
        code: "PRICE_MISMATCH",
        severity: "error",
        message: "评估中的价格与服务端重算结果不一致。",
      });
    }
  }

  // 验证 acknowledgement 归属完整性（F1：跨 evaluation 嫁接检测）
  if (evaluation.acknowledgement) {
    const ack = evaluation.acknowledgement;
    if (ack.modelRevisionId !== `${evaluation.modelId}@${evaluation.modelRevision}`) {
      issues.push({
        code: "ACKNOWLEDGEMENT_MODEL_MISMATCH",
        severity: "error",
        message: "确认记录的 modelRevisionId 与评估绑定不一致。",
      });
    }
    if (ack.pricingPolicyVersion !== evaluation.pricingPolicyRef) {
      issues.push({
        code: "ACKNOWLEDGEMENT_POLICY_MISMATCH",
        severity: "error",
        message: "确认记录的定价策略版本与评估绑定不一致。",
      });
    }
    if (ack.inputHash !== evaluation.result.inputHash) {
      issues.push({
        code: "ACKNOWLEDGEMENT_INPUT_HASH_MISMATCH",
        severity: "error",
        message: "确认记录的 inputHash 与评估结果不一致。",
      });
    }
    if (
      ack.purchasePriceRaw !== evaluation.result.purchasePriceRaw
      || ack.purchasePriceRounded !== evaluation.result.purchasePriceRounded
      || ack.purchasePrice !== evaluation.result.purchasePrice
    ) {
      issues.push({
        code: "ACKNOWLEDGEMENT_PRICE_MISMATCH",
        severity: "error",
        message: "确认记录的价格与评估结果不一致。",
      });
    }
  }

  // 评估状态必须是 ACKNOWLEDGED（若无超限）或 ACKNOWLEDGED（有超限且已确认）
  if (evaluation.status === "NON_FORMAL") {
    issues.push({
      code: "EVALUATION_NON_FORMAL",
      severity: "error",
      message: "评估为非正式状态，不能用于 Snapshot 发布。",
    });
  } else if (evaluation.status === "STALE") {
    issues.push({
      code: "EVALUATION_STALE",
      severity: "error",
      message: "评估已过期（输入已变化），不能用于 Snapshot 发布。",
    });
  } else if (evaluation.status === "OPEN") {
    issues.push({
      code: "PRICE_UPPER_THRESHOLD_CONFIRMATION_REQUIRED",
      severity: "error",
      message: "价格超限但尚未确认，必须先确认后才能发布 Snapshot。",
    });
  }

  return issues;
}

// ─── 确认 ────────────────────────────────────────────────────────────

/**
 * 对 OPEN 状态的评估添加确认。
 * 只有超限且 OPEN 的评估可以确认；确认后状态变 ACKNOWLEDGED。
 */
export function acknowledgeModelPricingEvaluation(
  evaluation: ModelPricingEvaluation,
  ackInput: {
    acknowledgedBy: string;
    acknowledgedAt: string;
    reason: string;
    acknowledgementId: string;
  },
): ModelPricingEvaluation {
  if (!evaluation.result.priceUpperThresholdExceeded) {
    throw new Error("当前评估未超过价格阈值，不需要确认。");
  }
  if (evaluation.status !== "OPEN") {
    throw new Error(`只有 OPEN 状态的评估可以确认，当前状态：${evaluation.status}。`);
  }

  const acknowledgement = acknowledgePriceWarning({
    trial: evaluation.result,
    modelRevisionId: `${evaluation.modelId}@${evaluation.modelRevision}`,
    acknowledgedBy: ackInput.acknowledgedBy,
    acknowledgedAt: ackInput.acknowledgedAt,
    reason: ackInput.reason,
    id: ackInput.acknowledgementId,
  });

  // 验证 acknowledgement 的 inputHash 与 evaluation 一致
  if (acknowledgement.inputHash !== evaluation.result.inputHash) {
    throw new Error("确认的 inputHash 与评估不一致。");
  }

  return {
    ...evaluation,
    status: "ACKNOWLEDGED",
    acknowledgement,
  };
}

// ─── 查找 ────────────────────────────────────────────────────────────

/**
 * 按 ID 和 revision 精确查找评估。
 * 返回 undefined 表示不存在；调用方自行决定是否 fallback 到 LEGACY 路径。
 */
export function findEvaluation(
  evaluations: readonly ModelPricingEvaluation[],
  id: string,
  revision?: number,
): ModelPricingEvaluation | undefined {
  const matches = evaluations.filter((e) => e.id === id);
  if (revision !== undefined) return matches.find((e) => e.revision === revision);
  // 无 revision 时返回最新
  return matches.reduce((latest, e) => (e.revision > latest.revision ? e : latest), matches[0]);
}

/** 评估 ID 生成：mpe-{modelId}-{shortHash} */
export function evaluationId(modelId: string): string {
  const shortHash = deterministicHash({ modelId, ts: Date.now() }).slice(0, 8);
  return `mpe-${modelId}-${shortHash}`;
}
