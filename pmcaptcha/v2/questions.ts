export function mathQuestion(): { question: string; answer: string } {
  const rand  = (min: number, max: number) => Math.floor(Math.random() * (max - min + 1)) + min;
  const type  = rand(0, 5);

  if (type === 0) {
    const a = rand(10, 99), b = rand(10, 99);
    return { question: `${a} + ${b}`, answer: String(a + b) };
  }
  if (type === 1) {
    const b = rand(10, 60), a = rand(b + 1, b + 60);
    return { question: `${a} - ${b}`, answer: String(a - b) };
  }
  if (type === 2) {
    const a = rand(2, 9), b = rand(11, 25);
    return { question: `${a} × ${b}`, answer: String(a * b) };
  }
  if (type === 3) {
    const divisor = rand(2, 12), quotient = rand(3, 15);
    const dividend = divisor * quotient;
    return { question: `${dividend} ÷ ${divisor}`, answer: String(quotient) };
  }
  if (type === 4) {
    const a = rand(2, 9), b = rand(2, 9), c = rand(1, 20);
    return { question: `${a} × ${b} + ${c}`, answer: String(a * b + c) };
  }
  const a = rand(2, 12);
  return { question: `${a}²`, answer: String(a * a) };
}

const TEXT_QA: { question: string; answer: string }[] = [
  { question: "天空是什么颜色？（中文）",           answer: "蓝色"   },
  { question: "一周有几天？（数字）",               answer: "7"      },
  { question: "一年有几个月？（数字）",             answer: "12"     },
  { question: "猫叫声是？（中文拟声词）",           answer: "喵"     },
  { question: "水的化学式是？",                    answer: "h2o"    },
  { question: "太阳从哪边升起？（东/西/南/北）",    answer: "东"     },
  { question: "地球上最大的洋是？（中文）",         answer: "太平洋" },
  { question: "1 + 1 等于几？（数字）",            answer: "2"      },
  { question: "中国的首都是哪个城市？（中文）",     answer: "北京"   },
  { question: "一天有多少小时？（数字）",           answer: "24"     },
  { question: "人有几根手指？（数字）",             answer: "10"     },
  { question: "苹果是什么颜色的？（中文，常见色）", answer: "红色"   },
  { question: "冰是什么状态的水？（固/液/气）",     answer: "固"     },
  { question: "地球围绕什么转？（中文）",           answer: "太阳"   },
  { question: "键盘上字母共有几个？（数字）",       answer: "26"     },
];

export function textQuestion(): { question: string; answer: string } {
  return TEXT_QA[Math.floor(Math.random() * TEXT_QA.length)];
}


function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) => [i, ...new Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}


export function answerMatches(input:string,answer:string,image:boolean):boolean {
  const inputNorm=input.trim().toUpperCase(),answerNorm=answer.trim().toUpperCase();
  return image?levenshtein(inputNorm,answerNorm)<=1:inputNorm===answerNorm;
}
