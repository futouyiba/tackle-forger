import type {
  AdjustmentRule,
  Affix,
  Candidate,
  CalculationTraceItem,
  ModifierOption,
  OfficialSku,
  QualityResult,
  RuleLayer,
  SeriesRecipe,
  ValidationIssue,
  WeightTemplate,
  WorkspaceState,
} from "./types";

type NumericMap = Record<string, number | string>;

const round = (value: number, precision = 4) => {
  const factor = 10 ** precision;
  return Math.round((value + Number.EPSILON) * factor) / factor;
};

class FormulaParser {
  private index = 0;
  private readonly tokens: string[];

  constructor(
    expression: string,
    private readonly variables: Record<string, number>,
  ) {
    this.tokens =
      expression.match(
        /\d+(?:\.\d+)?|[\u4e00-\u9fffA-Za-z_][\u4e00-\u9fffA-Za-z0-9_.]*|[()+\-*/^,]/g,
      ) ?? [];
  }

  parse(): number {
    const result = this.expression();
    if (this.index < this.tokens.length) throw new Error("公式存在无法识别的片段");
    if (!Number.isFinite(result)) throw new Error("公式结果不是有效数字");
    return result;
  }

  private peek() {
    return this.tokens[this.index];
  }

  private take() {
    return this.tokens[this.index++];
  }

  private expression(): number {
    let value = this.term();
    while (this.peek() === "+" || this.peek() === "-") {
      const operator = this.take();
      const right = this.term();
      value = operator === "+" ? value + right : value - right;
    }
    return value;
  }

  private term(): number {
    let value = this.power();
    while (this.peek() === "*" || this.peek() === "/") {
      const operator = this.take();
      const right = this.power();
      value = operator === "*" ? value * right : value / right;
    }
    return value;
  }

  private power(): number {
    let value = this.unary();
    while (this.peek() === "^") {
      this.take();
      value = value ** this.unary();
    }
    return value;
  }

  private unary(): number {
    if (this.peek() === "-") {
      this.take();
      return -this.unary();
    }
    if (this.peek() === "+") {
      this.take();
      return this.unary();
    }
    return this.primary();
  }

  private primary(): number {
    const token = this.take();
    if (token === "(") {
      const value = this.expression();
      if (this.take() !== ")") throw new Error("公式缺少右括号");
      return value;
    }
    if (/^\d/.test(token ?? "")) return Number(token);
    if (!token) throw new Error("公式意外结束");

    if (this.peek() === "(") {
      this.take();
      const args: number[] = [];
      if (this.peek() !== ")") {
        args.push(this.expression());
        while (this.peek() === ",") {
          this.take();
          args.push(this.expression());
        }
      }
      if (this.take() !== ")") throw new Error("函数缺少右括号");
      const fn = token.toLowerCase();
      if (fn === "min") return Math.min(...args);
      if (fn === "max") return Math.max(...args);
      if (fn === "abs") return Math.abs(args[0] ?? 0);
      if (fn === "round") return round(args[0] ?? 0, args[1] ?? 0);
      if (fn === "sqrt") return Math.sqrt(args[0] ?? 0);
      throw new Error("不支持的函数：" + token);
    }

    const variable = this.variables[token];
    if (variable === undefined) throw new Error("未知变量：" + token);
    return variable;
  }
}

export function evaluateFormula(
  expression: string,
  variables: Record<string, number>,
): number {
  return new FormulaParser(expression, variables).parse();
}

function selectedOptionIds(candidate: Candidate, layer: RuleLayer): string[] {
  const selected = candidate.selections;
  if (!layer.dimension) return layer.optionIds;
  if (layer.dimension === "structure") return selected.structureId ? [selected.structureId] : [];
  if (layer.dimension === "material") return selected.materialId ? [selected.materialId] : [];
  if (layer.dimension === "function") return selected.functionId ? [selected.functionId] : [];
  if (layer.dimension === "performance") return selected.performanceId ? [selected.performanceId] : [];
  if (layer.dimension === "technology") return selected.technologyIds;
  if (layer.dimension === "series") return selected.seriesId ? [selected.seriesId] : [];
  return [];
}

function applyRule(
  values: NumericMap,
  rule: AdjustmentRule,
  layerName: string,
  sourceName: string,
  trace: CalculationTraceItem[],
): void {
  const before = values[rule.parameterKey] ?? null;
  let after: number | string | null = before;
  const operand = rule.value;
  const current = typeof before === "number" ? before : 0;

  try {
    if (rule.operation === "set") {
      after = operand;
    } else if (rule.operation === "add") {
      after = current + Number(operand);
    } else if (rule.operation === "multiply") {
      after = current * Number(operand);
    } else if (rule.operation === "min") {
      after = Math.min(current, Number(operand));
    } else if (rule.operation === "max") {
      after = Math.max(current, Number(operand));
    } else if (rule.operation === "formula") {
      const variables: Record<string, number> = { current };
      Object.entries(values).forEach(([key, value]) => {
        if (typeof value === "number") variables[key] = value;
      });
      after = evaluateFormula(String(operand), variables);
    }
  } catch {
    after = before;
  }

  if (typeof after === "number") after = round(after);
  if (after !== null) values[rule.parameterKey] = after;
  trace.push({
    layer: layerName,
    source: sourceName,
    parameterKey: rule.parameterKey,
    operation: rule.operation,
    before,
    operand,
    after,
  });
}

export function scoreAffixes(state: WorkspaceState, affixIds: string[]): QualityResult {
  const affixes = affixIds
    .map((id) => state.affixes.find((item) => item.id === id))
    .filter((item): item is Affix => Boolean(item && item.enabled))
    .sort((a, b) => b.score - a.score);
  const tagCounts = new Map<string, number>();
  const contributions: QualityResult["contributions"] = [];
  let rawScore = 0;

  for (const affix of affixes) {
    rawScore += affix.score;
    const axis = affix.tags[0] ?? affix.category;
    const count = tagCounts.get(axis) ?? 0;
    const factor =
      state.affixScorePolicy.sameAxisFactors[
        Math.min(count, state.affixScorePolicy.sameAxisFactors.length - 1)
      ] ?? 1;
    tagCounts.set(axis, count + 1);
    const categoryWeight =
      affix.category === "passive"
        ? state.affixScorePolicy.passiveWeight
        : state.affixScorePolicy.directWeight;
    contributions.push({
      affixId: affix.id,
      base: affix.score,
      factor: factor * categoryWeight,
      score: round(affix.score * factor * categoryWeight, 2),
      note: count > 0 ? "同轴第 " + (count + 1) + " 条，递减计分" : "首条完整计分",
    });
  }

  const selected = new Set(affixes.map((affix) => affix.id));
  const pairKeys = new Set<string>();
  const bonuses: string[] = [];
  const penalties: string[] = [];
  let adjustment = 0;

  for (const affix of affixes) {
    for (const partner of affix.synergies) {
      if (!selected.has(partner)) continue;
      const key = [affix.id, partner].sort().join("|");
      if (pairKeys.has("s:" + key)) continue;
      pairKeys.add("s:" + key);
      adjustment += state.affixScorePolicy.synergyBonus;
      bonuses.push(
        affix.name +
          " × " +
          (state.affixes.find((item) => item.id === partner)?.name ?? partner) +
          " +" +
          state.affixScorePolicy.synergyBonus,
      );
    }
    for (const partner of affix.conflicts) {
      if (!selected.has(partner)) continue;
      const key = [affix.id, partner].sort().join("|");
      if (pairKeys.has("c:" + key)) continue;
      pairKeys.add("c:" + key);
      adjustment -= state.affixScorePolicy.conflictPenalty;
      penalties.push(
        affix.name +
          " × " +
          (state.affixes.find((item) => item.id === partner)?.name ?? partner) +
          " -" +
          state.affixScorePolicy.conflictPenalty,
      );
    }
  }

  const contributionScore = contributions.reduce((sum, item) => sum + item.score, 0);
  const finalScore = Math.max(0, round(contributionScore + adjustment, 2));
  const quality =
    [...state.qualityBands]
      .sort((a, b) => b.minScore - a.minScore)
      .find(
        (band) =>
          finalScore >= band.minScore &&
          (band.maxScore === null || finalScore <= band.maxScore),
      ) ?? state.qualityBands[0];

  return {
    rawScore: round(rawScore, 2),
    finalScore,
    qualityId: quality?.id ?? "green",
    contributions,
    bonuses,
    penalties,
  };
}

function validateEquipment(
  template: WeightTemplate,
  candidate: Candidate,
  values: NumericMap,
): { issues: ValidationIssue[]; safeWorkingForce: number } {
  const issues: ValidationIssue[] = [];
  const rod = Number(values["杆最大拉力kgf"] ?? 0);
  const reel = Number(values["轮最大拉力kgf"] ?? 0);
  const line = Number(values["线最大拉力kgf"] ?? 0);
  const safeWorkingForce = round(Math.min(rod * 0.9, reel, line * 0.35), 3);

  if (rod <= 0 || reel <= 0 || line <= 0) {
    issues.push({ level: "error", code: "FORCE_MISSING", message: "杆、轮、线最大拉力必须大于 0。" });
  }
  const reelRodRatio = rod > 0 ? reel / rod : 0;
  if (reelRodRatio < 0.55 || reelRodRatio > 1.2) {
    issues.push({
      level: "warning",
      code: "REEL_ROD_RATIO",
      message: "轮/杆拉力比 " + round(reelRodRatio, 2) + " 超出建议 0.55–1.20。",
    });
  }
  const lineReelRatio = reel > 0 ? line / reel : 0;
  if (lineReelRatio < 1.4 || lineReelRatio > 4) {
    issues.push({
      level: "warning",
      code: "LINE_REEL_RATIO",
      message: "线/轮拉力比 " + round(lineReelRatio, 2) + " 超出建议 1.40–4.00。",
    });
  }
  if (
    candidate.fishMinKg > template.nominalFishKg ||
    candidate.fishMaxKg < template.nominalFishKg
  ) {
    issues.push({
      level: "error",
      code: "TEMPLATE_COVERAGE",
      message: "SKU 目标重量段没有覆盖模板标称鱼重。",
    });
  }
  const lureMin = Number(values["饵重下限g"] ?? 0);
  const lureMax = Number(values["饵重上限g"] ?? 0);
  if (lureMin >= lureMax) {
    issues.push({ level: "error", code: "LURE_RANGE", message: "饵重下限必须小于上限。" });
  }
  if (Number(values["杆自重g"] ?? 0) <= 0 || Number(values["轮自重g"] ?? 0) <= 0) {
    issues.push({ level: "error", code: "WEIGHT_INVALID", message: "杆轮自重必须大于 0。" });
  }
  if (!issues.length) {
    issues.push({ level: "info", code: "PASS", message: "结构、强度和模板覆盖校验通过。" });
  }
  return { issues, safeWorkingForce };
}

export function calculateCandidate(
  state: WorkspaceState,
  candidate: Candidate,
  options?: { executionMode?: "legacy_performance_replay" },
): Candidate {
  const legacyPerformanceReplay = options?.executionMode === "legacy_performance_replay";
  const template = state.templates.find((item) => item.id === candidate.templateId);
  if (!template) {
    return {
      ...candidate,
      calculated: {
        values: {},
        quality: scoreAffixes(state, candidate.affixIds),
        trace: [],
        issues: [{ level: "error", code: "TEMPLATE_MISSING", message: "找不到重量模板。" }],
        safeWorkingForce: 0,
        priceIndex: 0,
      },
    };
  }

  const values: NumericMap = { ...template.values };
  const trace: CalculationTraceItem[] = [];
  const layers = [...state.layers].filter((layer) => layer.enabled).sort((a, b) => a.order - b.order);
  const modifierById = new Map<string, ModifierOption>(
    state.modifiers.filter((item) => item.enabled).map((item) => [item.id, item]),
  );

  for (const layer of layers) {
    if (layer.id === "layer-affix") {
      for (const affixId of candidate.affixIds) {
        const affix = state.affixes.find((item) => item.id === affixId && item.enabled);
        if (!affix) continue;
        affix.rules.forEach((rule) => applyRule(values, rule, layer.name, affix.name, trace));
      }
      continue;
    }
    if (layer.id === "layer-manual") {
      Object.entries(candidate.overrides).forEach(([parameterKey, value], index) => {
        applyRule(
          values,
          {
            id: "manual-" + index,
            parameterKey,
            operation: "set",
            value,
          },
          layer.name,
          "候选手工覆盖",
          trace,
        );
      });
      continue;
    }

    if (layer.dimension === "performance" && !legacyPerformanceReplay) continue;
    for (const optionId of selectedOptionIds(candidate, layer)) {
      const option = modifierById.get(optionId);
      if (!option) continue;
      option.rules.forEach((rule) => applyRule(values, rule, layer.name, option.name, trace));
    }
    layer.rules.forEach((rule) => applyRule(values, rule, layer.name, layer.name, trace));
  }

  const quality = scoreAffixes(state, candidate.affixIds);
  const validation = validateEquipment(template, candidate, values);
  const band = state.qualityBands.find((item) => item.id === quality.qualityId);
  const specialization =
    Number(Boolean(candidate.selections.functionId)) +
    Number(legacyPerformanceReplay && Boolean(candidate.selections.performanceId)) +
    candidate.selections.technologyIds.length;
  const priceIndex = round((band?.priceIndex ?? 1) * (1 + specialization * 0.04), 2);

  return {
    ...candidate,
    calculated: {
      values,
      quality,
      trace,
      issues: validation.issues,
      safeWorkingForce: validation.safeWorkingForce,
      priceIndex,
    },
  };
}

function pickOptionalAffixes(recipe: SeriesRecipe, index: number): string[] {
  if (recipe.optionalSlots <= 0 || !recipe.optionalAffixPoolIds.length) return [];
  const result: string[] = [];
  for (let offset = 0; offset < recipe.optionalSlots; offset += 1) {
    const id = recipe.optionalAffixPoolIds[(index + offset) % recipe.optionalAffixPoolIds.length];
    if (id && !result.includes(id) && !recipe.requiredAffixIds.includes(id)) result.push(id);
  }
  return result;
}

export function generateCandidatesForRecipe(
  state: WorkspaceState,
  recipe: SeriesRecipe,
  options?: { executionMode?: "legacy_performance_replay" },
): Candidate[] {
  const templates = recipe.templateIds.length ? recipe.templateIds : state.templates.map((item) => item.id);
  const structures = recipe.structureIds.length ? recipe.structureIds : [undefined];
  const functions = recipe.functionIds.length ? recipe.functionIds : [undefined];
  const performances = options?.executionMode === "legacy_performance_replay" && recipe.performanceIds.length
    ? recipe.performanceIds
    : [undefined];
  const now = new Date().toISOString();
  const generated: Candidate[] = [];
  let sequence = 0;

  outer:
  for (const templateId of templates) {
    for (const structureId of structures) {
      for (const functionId of functions) {
        for (const performanceId of performances) {
          sequence += 1;
          const comboId =
            recipe.platformId +
            "-" +
            templateId.replace(/\D/g, "").padStart(2, "0") +
            "-" +
            String(sequence).padStart(2, "0");
          const draft: Candidate = {
            id: "candidate-" + recipe.id + "-" + String(sequence).padStart(3, "0"),
            recipeId: recipe.id,
            comboId,
            platformId: recipe.platformId,
            platformPosition: recipe.platformPosition,
            seriesName: recipe.name,
            templateId,
            fishMinKg: recipe.fishMinKg,
            fishMaxKg: recipe.fishMaxKg,
            selections: {
              structureId,
              functionId,
              performanceId,
              technologyIds: recipe.technologyIds,
            },
            affixIds: [
              ...recipe.requiredAffixIds,
              ...pickOptionalAffixes(recipe, sequence - 1),
            ],
            useScene: recipe.useScene,
            overrides: {},
            status: "candidate",
            calculated: {
              values: {},
              quality: {
                rawScore: 0,
                finalScore: 0,
                qualityId: "green",
                contributions: [],
                bonuses: [],
                penalties: [],
              },
              trace: [],
              issues: [],
              safeWorkingForce: 0,
              priceIndex: 1,
            },
            notes: "由系列配方约束生成。",
            createdAt: now,
            updatedAt: now,
          };
          generated.push(calculateCandidate(state, draft));
          if (generated.length >= recipe.maxCandidates) break outer;
        }
      }
    }
  }

  return generated;
}

function modifierName(state: WorkspaceState, id?: string): string {
  return state.modifiers.find((item) => item.id === id)?.name ?? "";
}

export function publishCandidate(state: WorkspaceState, candidate: Candidate): OfficialSku {
  if (candidate.selections.performanceId) {
    throw new Error("Performance 是只读历史证据；旧候选只能重放，不能发布新的 OfficialSku。");
  }
  const calculated = calculateCandidate(state, candidate);
  const values = calculated.calculated.values;
  const tone =
    calculated.toneOverride ||
    String(values["钓性"] ?? "");
  const hardness =
    calculated.hardnessOverride ||
    String(values["硬度"] ?? "");
  const lengthM =
    calculated.lengthOverride ??
    Number(values["杆长m"] ?? 0);
  const functionOption = state.modifiers.find((item) => item.id === calculated.selections.functionId);
  const performanceOption = state.modifiers.find((item) => item.id === calculated.selections.performanceId);
  return {
    id: "sku-" + calculated.comboId,
    candidateId: calculated.id,
    comboId: calculated.comboId,
    platformId: calculated.platformId,
    platformPosition: calculated.platformPosition,
    templateId: calculated.templateId,
    seriesName: calculated.seriesName,
    qualityId: calculated.calculated.quality.qualityId,
    fishMinKg: calculated.fishMinKg,
    fishMaxKg: calculated.fishMaxKg,
    structureName: modifierName(state, calculated.selections.structureId),
    functionName: functionOption?.name ?? "",
    functionLevel: String(functionOption?.level ?? ""),
    performanceName: performanceOption?.name ?? "",
    performanceLevel: String(performanceOption?.level ?? ""),
    affixIds: calculated.affixIds,
    tone,
    hardness,
    lengthM: round(lengthM, 2),
    useScene: calculated.useScene,
    rodId: calculated.comboId + "_R",
    reelId: calculated.comboId + "_W",
    lineId: calculated.comboId + "_L",
    priceIndex: calculated.calculated.priceIndex,
    rodForce: Number(values["杆最大拉力kgf"] ?? 0),
    reelForce: Number(values["轮最大拉力kgf"] ?? 0),
    lineForce: Number(values["线最大拉力kgf"] ?? 0),
    safeWorkingForce: calculated.calculated.safeWorkingForce,
    values,
    overrides: calculated.overrides,
    notes: calculated.notes,
    publishedAt: new Date().toISOString(),
  };
}

export function recalculateWorkspace(state: WorkspaceState): WorkspaceState {
  return {
    ...state,
    candidates: state.candidates.map((candidate) => calculateCandidate(
      state,
      candidate,
      { executionMode: "legacy_performance_replay" },
    )),
  };
}

export function suggestRulesFromOverrides(state: WorkspaceState): Array<{
  parameterKey: string;
  count: number;
  averageDelta: number;
  suggestedOperation: "add";
  summary: string;
}> {
  const bucket = new Map<string, number[]>();
  for (const candidate of state.candidates) {
    const template = state.templates.find((item) => item.id === candidate.templateId);
    if (!template) continue;
    for (const [key, override] of Object.entries(candidate.overrides)) {
      const base = template.values[key];
      if (typeof override !== "number" || typeof base !== "number") continue;
      bucket.set(key, [...(bucket.get(key) ?? []), override - base]);
    }
  }
  return Array.from(bucket.entries())
    .filter(([, values]) => values.length >= 2)
    .map(([parameterKey, values]) => {
      const averageDelta = round(values.reduce((sum, value) => sum + value, 0) / values.length, 4);
      return {
        parameterKey,
        count: values.length,
        averageDelta,
        suggestedOperation: "add" as const,
        summary: values.length + " 次精调，平均相对模板 " + (averageDelta >= 0 ? "+" : "") + averageDelta,
      };
    })
    .sort((a, b) => b.count - a.count);
}
