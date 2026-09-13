import {renderHelp as renderPluginHelp} from "./v2/help";
import {definePlugin} from "telebox/sdk";

const MAX_EXPR_LENGTH = 120;
const MAX_ABS_RESULT = Number.MAX_SAFE_INTEGER;

type CalculationErrorMessage =
  | "表达式为空"
  | "表达式包含不支持的字符"
  | "表达式格式错误"
  | "计算结果超出安全范围"
  | "除零错误"
  | "计算结果无效"
  | "括号不匹配"
  | "数字格式错误"
  | "数字超出范围";

class CalculationError extends Error {
  constructor(readonly publicMessage: CalculationErrorMessage) {
    super(publicMessage);
    this.name = "CalculationError";
  }
}

const fail = (message: CalculationErrorMessage): never => {
  throw new CalculationError(message);
};

class Parser {
  private index = 0;
  constructor(private readonly text: string) {}

  parse(): number {
    if (!this.text.trim()) fail("表达式为空");
    if (!/^[0-9+\-*/().\s]+$/.test(this.text)) fail("表达式包含不支持的字符");
    const value = this.additive();
    this.skipSpace();
    if (this.index !== this.text.length) fail("表达式格式错误");
    if (!Number.isFinite(value) || Math.abs(value) > MAX_ABS_RESULT) fail("计算结果超出安全范围");
    return value;
  }

  private additive(): number {
    let value = this.multiplicative();
    for (;;) {
      this.skipSpace();
      const op = this.text[this.index];
      if (op !== "+" && op !== "-") return value;
      this.index++;
      const right = this.multiplicative();
      value = op === "+" ? value + right : value - right;
    }
  }

  private multiplicative(): number {
    let value = this.unary();
    for (;;) {
      this.skipSpace();
      const op = this.text[this.index];
      if (op !== "*" && op !== "/") return value;
      this.index++;
      const right = this.unary();
      if (op === "/" && right === 0) fail("除零错误");
      value = op === "*" ? value * right : value / right;
      if (!Number.isFinite(value)) fail("计算结果无效");
    }
  }

  private unary(): number {
    this.skipSpace();
    const op = this.text[this.index];
    if (op === "+" || op === "-") {
      this.index++;
      const value = this.unary();
      return op === "-" ? -value : value;
    }
    return this.primary();
  }

  private primary(): number {
    this.skipSpace();
    if (this.text[this.index] === "(") {
      this.index++;
      const value = this.additive();
      this.skipSpace();
      if (this.text[this.index] !== ")") fail("括号不匹配");
      this.index++;
      return value;
    }
    const start = this.index;
    while (/[0-9.]/.test(this.text[this.index] ?? "")) this.index++;
    const token = this.text.slice(start, this.index);
    if (!/^\d+(?:\.\d+)?$/.test(token)) fail("数字格式错误");
    const value = Number(token);
    if (!Number.isFinite(value)) fail("数字超出范围");
    return value;
  }

  private skipSpace(): void {
    while (/\s/.test(this.text[this.index] ?? "")) this.index++;
  }
}

function escape(value: string): string {
  return value.replace(/[&<>\"']/g, char => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"})[char]!);
}

function format(value: number): string {
  if (Number.isInteger(value)) return String(value);
  const rounded = Math.round(value * 1e12) / 1e12;
  return rounded === 0 ? "0" : String(rounded);
}

export default function createCalc() {
  return definePlugin({renderHelp: renderPluginHelp, apiVersion: 1, id: "calc", description: "安全计算四则运算表达式",
    commands: {calc: {helpArgs: ["help","h"], helpOnEmpty: true, description: "计算四则运算表达式", async handle(invocation, ctx) {
      const expression = invocation.args.join(" ").trim();
      if (!expression || expression.toLowerCase() === "help" || expression.toLowerCase() === "h") {
        await ctx.telegram.edit(invocation.message, renderPluginHelp(invocation.prefix), {parseMode: "html", linkPreview: false});
        return;
      }
      if (expression.length > MAX_EXPR_LENGTH) {
        await ctx.telegram.edit(invocation.message,
          `❌ <b>表达式过长</b><br/><br/>最大长度: ${MAX_EXPR_LENGTH} 字符<br/>当前长度: ${expression.length}`,
          {parseMode: "html"});
        return;
      }
      let result: number;
      try {
        result = new Parser(expression).parse();
      } catch (error) {
        const message = error instanceof CalculationError ? error.publicMessage : "表达式无效";
        if (!(error instanceof CalculationError)) ctx.log.error("calc_calculation_failed");
        await ctx.telegram.edit(invocation.message,
          `🚫 <b>计算失败</b><br/><br/>表达式: <code>${escape(expression)}</code><br/>错误: ${message}`,
          {parseMode: "html"});
        return;
      }
      await ctx.telegram.edit(invocation.message,
        `🧮 <b>计算结果</b><br/><br/><code>${escape(expression)}</code><br/>= <b>${format(result)}</b>`,
        {parseMode: "html", linkPreview: false});
    }}},
  });
}
