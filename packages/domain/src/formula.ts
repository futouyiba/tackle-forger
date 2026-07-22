import Decimal from "decimal.js";

export type FormulaContext = Record<string, number>;

type Token =
  | { type: "number"; value: number }
  | { type: "identifier"; value: string }
  | { type: "operator"; value: string }
  | { type: "punctuation"; value: "(" | ")" | "," };

type Expression =
  | { type: "number"; value: number }
  | { type: "reference"; name: string }
  | { type: "unary"; operator: "+" | "-"; operand: Expression }
  | { type: "binary"; operator: "+" | "-" | "*" | "/"; left: Expression; right: Expression }
  | { type: "call"; name: string; args: Expression[] };

const allowedFunctions = new Set(["min", "max", "abs", "round", "floor", "ceil"]);

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;

  while (index < source.length) {
    const char = source[index]!;
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }

    const number = source.slice(index).match(/^\d+(?:\.\d+)?/);
    if (number) {
      tokens.push({ type: "number", value: Number(number[0]) });
      index += number[0].length;
      continue;
    }

    const identifier = source.slice(index).match(/^[A-Za-z_][A-Za-z0-9_.]*/);
    if (identifier) {
      tokens.push({ type: "identifier", value: identifier[0] });
      index += identifier[0].length;
      continue;
    }

    if ("+-*/".includes(char)) {
      tokens.push({ type: "operator", value: char });
      index += 1;
      continue;
    }

    if (char === "(" || char === ")" || char === ",") {
      tokens.push({ type: "punctuation", value: char });
      index += 1;
      continue;
    }

    throw new Error(`Unsupported formula token at position ${index}: ${char}`);
  }

  return tokens;
}

class Parser {
  private index = 0;

  constructor(private readonly tokens: Token[]) {}

  parse(): Expression {
    const expression = this.parseAdditive();
    if (this.index !== this.tokens.length) {
      throw new Error("Unexpected trailing formula tokens");
    }
    return expression;
  }

  private parseAdditive(): Expression {
    let expression = this.parseMultiplicative();
    while (this.matchOperator("+") || this.matchOperator("-")) {
      const operator = (this.tokens[this.index - 1] as { value: "+" | "-" }).value;
      expression = { type: "binary", operator, left: expression, right: this.parseMultiplicative() };
    }
    return expression;
  }

  private parseMultiplicative(): Expression {
    let expression = this.parseUnary();
    while (this.matchOperator("*") || this.matchOperator("/")) {
      const operator = (this.tokens[this.index - 1] as { value: "*" | "/" }).value;
      expression = { type: "binary", operator, left: expression, right: this.parseUnary() };
    }
    return expression;
  }

  private parseUnary(): Expression {
    if (this.matchOperator("+") || this.matchOperator("-")) {
      const operator = (this.tokens[this.index - 1] as { value: "+" | "-" }).value;
      return { type: "unary", operator, operand: this.parseUnary() };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): Expression {
    const token = this.tokens[this.index];
    if (!token) throw new Error("Unexpected end of formula");

    if (token.type === "number") {
      this.index += 1;
      return { type: "number", value: token.value };
    }

    if (token.type === "identifier") {
      this.index += 1;
      if (this.matchPunctuation("(")) {
        if (!allowedFunctions.has(token.value)) throw new Error(`Unknown function: ${token.value}`);
        const args: Expression[] = [];
        if (!this.checkPunctuation(")")) {
          do args.push(this.parseAdditive()); while (this.matchPunctuation(","));
        }
        this.consumePunctuation(")");
        return { type: "call", name: token.value, args };
      }
      return { type: "reference", name: token.value };
    }

    if (this.matchPunctuation("(")) {
      const expression = this.parseAdditive();
      this.consumePunctuation(")");
      return expression;
    }

    throw new Error("Invalid formula expression");
  }

  private matchOperator(value: string): boolean {
    const token = this.tokens[this.index];
    if (token?.type === "operator" && token.value === value) {
      this.index += 1;
      return true;
    }
    return false;
  }

  private checkPunctuation(value: "(" | ")" | ","): boolean {
    const token = this.tokens[this.index];
    return token?.type === "punctuation" && token.value === value;
  }

  private matchPunctuation(value: "(" | ")" | ","): boolean {
    if (!this.checkPunctuation(value)) return false;
    this.index += 1;
    return true;
  }

  private consumePunctuation(value: "(" | ")" | ","): void {
    if (!this.matchPunctuation(value)) throw new Error(`Expected '${value}'`);
  }
}

function evaluateExpression(expression: Expression, context: FormulaContext): Decimal {
  switch (expression.type) {
    case "number":
      return new Decimal(expression.value);
    case "reference": {
      const value = context[expression.name];
      if (value === undefined) throw new Error(`Unknown formula reference: ${expression.name}`);
      return new Decimal(value);
    }
    case "unary": {
      const value = evaluateExpression(expression.operand, context);
      return expression.operator === "-" ? value.negated() : value;
    }
    case "binary": {
      const left = evaluateExpression(expression.left, context);
      const right = evaluateExpression(expression.right, context);
      if (expression.operator === "+") return left.plus(right);
      if (expression.operator === "-") return left.minus(right);
      if (expression.operator === "*") return left.times(right);
      if (right.isZero()) throw new Error("Formula division by zero");
      return left.dividedBy(right);
    }
    case "call": {
      const args = expression.args.map((arg) => evaluateExpression(arg, context));
      if (expression.name === "min") return Decimal.min(...args);
      if (expression.name === "max") return Decimal.max(...args);
      if (expression.name === "abs") return requireArgs(expression.name, args, 1)[0]!.abs();
      if (expression.name === "floor") return requireArgs(expression.name, args, 1)[0]!.floor();
      if (expression.name === "ceil") return requireArgs(expression.name, args, 1)[0]!.ceil();
      const [value, places = new Decimal(0)] = requireArgs(expression.name, args, [1, 2]);
      return value!.toDecimalPlaces(places!.toNumber());
    }
  }
}

function requireArgs(name: string, args: Decimal[], expected: number | number[]): Decimal[] {
  const allowed = Array.isArray(expected) ? expected : [expected];
  if (!allowed.includes(args.length)) throw new Error(`${name} expects ${allowed.join(" or ")} arguments`);
  return args;
}

export function evaluateFormula(source: string, context: FormulaContext): number {
  const ast = new Parser(tokenize(source)).parse();
  return evaluateExpression(ast, context).toNumber();
}
