export function stallReason(text) {
  if (/\s{4}$/.test(text)) return "repeated_whitespace";
  if (/(\S)\1{7}$/.test(text)) return "repeated_character";
  const words = text.trim().split(/\s+/);
  if (words.length >= 6 && words.slice(-6).every((w) => w === words.at(-1)))
    return "repeated_pattern";
  for (
    let size = 2;
    size <= Math.min(40, Math.floor(text.length / 4));
    size++
  ) {
    const unit = text.slice(-size);
    if (size * 4 >= 24 && unit.trim() && text.endsWith(unit.repeat(4)))
      return "repeated_pattern";
  }
  return null;
}
export function budgetReason(s, now = Date.now()) {
  if (s.steps.length >= s.callBudget) return "call_budget";
  if (s.usage.input + s.usage.output >= s.tokenBudget) return "token_budget";
  if (now - s.startedAt >= s.timeBudgetMs) return "time_budget";
  return null;
}
