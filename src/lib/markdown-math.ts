// Models sometimes emit one stray "}" (or miss one) in a display equation. KaTeX then rejects the
// whole block and prints raw red source, so drop unmatched closers and close unmatched openers.
function balanceBraces(expression: string): string {
  let depth = 0;
  let result = '';
  for (let i = 0; i < expression.length; i += 1) {
    const char = expression[i];
    if (char === '\\') {
      result += char + (expression[i + 1] ?? '');
      i += 1;
    } else if (char === '{') {
      depth += 1;
      result += char;
    } else if (char === '}') {
      if (depth === 0) continue;
      depth -= 1;
      result += char;
    } else {
      result += char;
    }
  }
  return result + '}'.repeat(depth);
}

export function normalizeMathMarkdown(content: string): string {
  return content
    .replace(/\\\[\s*([\s\S]*?)\s*\\\]/g, (_, expression: string) => `\n$$\n${balanceBraces(expression.trim())}\n$$\n`)
    .replace(/\$\$([\s\S]*?)\$\$/g, (_, expression: string) => `$$${balanceBraces(expression)}$$`)
    .replace(/\\\(\s*([\s\S]*?)\s*\\\)/g, (_, expression: string) => `$${balanceBraces(expression.trim())}$`);
}
