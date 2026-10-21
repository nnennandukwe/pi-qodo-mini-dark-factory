export function hasCompleteUsage(record) {
  if (record?.usage_complete !== true || !record.usage) return false;
  const usage = record.usage;
  return [usage.input_tokens ?? usage.input, usage.output_tokens ?? usage.output,
    usage.cost_usd, usage.turns].every((value) => Number.isFinite(value) && value >= 0);
}
