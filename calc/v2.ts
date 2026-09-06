import {definePlugin} from "telebox/sdk";

const MAX_EXPR_LENGTH = 120;
const MAX_ABS_RESULT = Number.MAX_SAFE_INTEGER;

class Parser {
  private index = 0;
  constructor(private readonly text: string) {}

  parse(): number {
    const value = this.additive();
    this.skipSpace();
    if (this.index !== this.text.length) throw new Error("表达式格式错误");
    if (!Number.isFinite(value) || Math.abs(value) > MAX_ABS_RESULT) throw new Error("计算结果超出安全范围");
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
      if (op === "/" && right === 0) throw new Error("除零错误");
      value = op === "*" ? value * right : value / right;
      if (!Number.isFinite(value)) throw new Error("计算结果无效");
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
      if (this.text[this.index] !== ")") throw new Error("括号不匹配");
      this.index++;
      return value;
    }
    const start = this.index;
    while (/[0-9.]/.test(this.text[this.index] ?? "")) this.index++;
    const token = this.text.slice(start, this.index);
    if (!/^\d+(?:\.\d+)?$/.test(token)) throw new Error("数字格式错误");
    const value = Number(token);
    if (!Number.isFinite(value)) throw new Error("数字超出范围");
    return value;
  }

  private skipSpace(): void {
    while (/\s/.test(this.text[this.index] ?? "")) this.index++;
  }
}

function escape(value: string): string {
  return value.replace(/[&<>\"]/g, char => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;"})[char]!);
}

function format(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toPrecision(12).replace(/\.?(0+)(?:e|$)/, "").replace(/e\+/, "e");
}

const help = (prefix: string) => `<b>计算器</b>\n<code>${escape(prefix)}calc 2+2*5</code>\n<code>${escape(prefix)}calc (10-3)*4</code>\n支持括号、小数和负数。`;

export default function createCalc() {
  return definePlugin({apiVersion: 1, id: "calc", description: "安全计算四则运算表达式",
    commands: {calc: {description: "计算四则运算表达式", async handle(invocation, ctx) {
      const expression = invocation.args.join(" ").trim();
      if (!expression || expression.toLowerCase() === "help" || expression.toLowerCase() === "h") {
        await ctx.telegram.edit(invocation.message, help(invocation.prefix), {parseMode: "html"});
        return;
      }
      if (expression.length > MAX_EXPR_LENGTH) {
        await ctx.telegram.edit(invocation.message, `<b>计算失败</b>\n表达式长度不能超过 <code>${MAX_EXPR_LENGTH}</code> 个字符`, {parseMode: "html"});
        return;
      }
      try {
        const result = new Parser(expression).parse();
        await ctx.telegram.edit(invocation.message, `<b>计算结果</b>\n<code>${escape(expression)}</code> = <code>${format(result)}</code>`, {parseMode: "html"});
      } catch (error) {
        const message = error instanceof Error ? error.message : "表达式无效";
        await ctx.telegram.edit(invocation.message, `<b>计算失败</b>\n<code>${escape(expression)}</code>\n${escape(message)}`, {parseMode: "html"});
      }
    }}},
  });
}
