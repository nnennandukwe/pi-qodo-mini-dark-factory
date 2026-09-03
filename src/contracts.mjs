function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function nonEmptyStringArray(value) {
  return Array.isArray(value) && value.length > 0 && value.every(nonEmptyString);
}

function unique(values) {
  return new Set(values).size === values.length;
}

function sameMembers(left, right) {
  return left.length === right.length && left.every((item) => right.includes(item));
}

function result(errors) {
  return { ok: errors.length === 0, errors };
}

export function validateTask(task) {
  const errors = [];
  if (!isPlainObject(task)) return result(["task must be an object"]);
  if (!nonEmptyString(task.id)) errors.push("task.id must be a non-empty string");
  if (!nonEmptyString(task.title)) errors.push("task.title must be a non-empty string");
  if (!nonEmptyString(task.issue)) errors.push("task.issue must be a non-empty string");
  const hasFixture = nonEmptyString(task.fixture);
  const hasRepository = isPlainObject(task.repository);
  if (hasFixture === hasRepository) {
    errors.push("task must define exactly one source: fixture or repository");
  }
  if (hasRepository) {
    for (const key of ["url", "clone_ref", "base_ref", "repo_full_name"]) {
      if (!nonEmptyString(task.repository[key])) {
        errors.push(`task.repository.${key} must be a non-empty string`);
      }
    }
  }
  if (!nonEmptyStringArray(task.acceptance_criteria)) {
    errors.push("task.acceptance_criteria must be a non-empty string array");
  }
  if (!nonEmptyStringArray(task.files_expected)) {
    errors.push("task.files_expected must be a non-empty string array");
  }
  if (!nonEmptyStringArray(task.files_allowed)) {
    errors.push("task.files_allowed must be a non-empty string array");
  }
  if (!nonEmptyStringArray(task.required_test_files)) {
    errors.push("task.required_test_files must be a non-empty string array");
  }
  if (!nonEmptyStringArray(task.constraints)) {
    errors.push("task.constraints must be a non-empty string array");
  }
  if (!nonEmptyStringArray(task.non_goals)) {
    errors.push("task.non_goals must be a non-empty string array");
  }
  if (!Array.isArray(task.verification) || task.verification.length === 0) {
    errors.push("task.verification must contain at least one command");
  } else {
    for (const [index, check] of task.verification.entries()) {
      if (!isPlainObject(check)) {
        errors.push(`task.verification[${index}] must be an object`);
        continue;
      }
      if (!nonEmptyString(check.id)) errors.push(`task.verification[${index}].id is required`);
      if (!Array.isArray(check.argv) || check.argv.length === 0 || !check.argv.every(nonEmptyString)) {
        errors.push(`task.verification[${index}].argv must be a non-empty string array`);
      }
      if (check.required !== true && check.required !== false) {
        errors.push(`task.verification[${index}].required must be boolean`);
      }
    }
  }

  for (const key of ["files_expected", "files_allowed", "required_test_files"]) {
    if (Array.isArray(task[key]) && !unique(task[key])) errors.push(`task.${key} contains duplicates`);
  }
  if (
    Array.isArray(task.files_expected) &&
    Array.isArray(task.files_allowed) &&
    task.files_expected.some((file) => !task.files_allowed.includes(file))
  ) {
    errors.push("every expected file must also be allowed");
  }
  if (
    Array.isArray(task.required_test_files) &&
    Array.isArray(task.files_allowed) &&
    task.required_test_files.some((file) => !task.files_allowed.includes(file))
  ) {
    errors.push("every required test file must also be allowed");
  }
  return result(errors);
}

export function validatePlan(plan, task) {
  const errors = [];
  if (!isPlainObject(plan)) return result(["plan must be an object"]);
  if (plan.task_id !== task.id) errors.push("plan.task_id must match task.id");
  if (!nonEmptyString(plan.summary)) errors.push("plan.summary is required");
  for (const key of ["acceptance_criteria", "affected_files", "steps", "risks", "non_goals"]) {
    if (!nonEmptyStringArray(plan[key])) errors.push(`plan.${key} must be a non-empty string array`);
  }
  if (
    Array.isArray(plan.acceptance_criteria) &&
    !sameMembers(plan.acceptance_criteria, task.acceptance_criteria)
  ) {
    errors.push("plan.acceptance_criteria must exactly cover the task criteria");
  }
  if (
    Array.isArray(plan.affected_files) &&
    plan.affected_files.some((file) => !task.files_allowed.includes(file))
  ) {
    errors.push("plan.affected_files contains a path outside task.files_allowed");
  }
  if (
    Array.isArray(plan.affected_files) &&
    task.files_expected.some((file) => !plan.affected_files.includes(file))
  ) {
    errors.push("plan.affected_files must include every expected file");
  }
  return result(errors);
}

export function validateImplementationReport(report, task, actualChangedFiles) {
  const errors = [];
  if (!isPlainObject(report)) return result(["implementation report must be an object"]);
  if (report.task_id !== task.id) errors.push("implementation.task_id must match task.id");
  if (!nonEmptyString(report.summary)) errors.push("implementation.summary is required");
  for (const key of ["changed_files", "commands_run", "assumptions", "unresolved_risks"]) {
    if (!Array.isArray(report[key]) || !report[key].every(nonEmptyString)) {
      errors.push(`implementation.${key} must be a string array`);
    }
  }
  if (Array.isArray(report.changed_files) && !sameMembers(report.changed_files, actualChangedFiles)) {
    errors.push("reported changed_files must exactly match the Git worktree");
  }
  const unexpected = actualChangedFiles.filter((file) => !task.files_allowed.includes(file));
  if (unexpected.length > 0) errors.push(`out-of-scope files changed: ${unexpected.join(", ")}`);
  const missingTests = task.required_test_files.filter((file) => !actualChangedFiles.includes(file));
  if (missingTests.length > 0) errors.push(`required test files were not changed: ${missingTests.join(", ")}`);
  return result(errors);
}

export function validateReview(review, task) {
  const errors = [];
  if (!isPlainObject(review)) return result(["review must be an object"]);
  if (review.task_id !== task.id) errors.push("review.task_id must match task.id");
  if (!["approve", "request_changes"].includes(review.decision)) {
    errors.push("review.decision must be approve or request_changes");
  }
  if (typeof review.evidence_sufficient !== "boolean") {
    errors.push("review.evidence_sufficient must be boolean");
  }
  if (!Array.isArray(review.findings)) {
    errors.push("review.findings must be an array");
  } else {
    for (const [index, finding] of review.findings.entries()) {
      if (!isPlainObject(finding)) {
        errors.push(`review.findings[${index}] must be an object`);
        continue;
      }
      if (!["low", "medium", "high", "critical"].includes(finding.severity)) {
        errors.push(`review.findings[${index}].severity is invalid`);
      }
      if (!nonEmptyString(finding.summary)) errors.push(`review.findings[${index}].summary is required`);
      if (!nonEmptyString(finding.file)) errors.push(`review.findings[${index}].file is required`);
    }
  }
  if (!Array.isArray(review.skipped_checks) || !review.skipped_checks.every(nonEmptyString)) {
    errors.push("review.skipped_checks must be a string array");
  }
  return result(errors);
}

export function reviewGate(review) {
  const reasons = [];
  const blockingFindings = review.findings.filter((finding) =>
    ["high", "critical"].includes(finding.severity),
  );
  if (review.decision !== "approve") reasons.push(`review decision was ${review.decision}`);
  if (review.evidence_sufficient !== true) reasons.push("reviewer marked evidence insufficient");
  if (blockingFindings.length > 0) reasons.push("review contains high or critical findings");
  if (review.skipped_checks.length > 0) reasons.push("review records skipped checks");
  return { passed: reasons.length === 0, reasons };
}
