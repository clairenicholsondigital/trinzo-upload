'use strict';

// An absent snapshot belongs to work that started before this policy existed.
// Never consult current flags when resuming such a run.
const SEMANTIC_POLICY_VERSION = 1;
const SEMANTIC_TASK_VERSION = 'existing-survivor-v2';
const ACTION_SCOPES = new Set(['contact_enquiries', 'bounded_existing_survivors', 'contact_and_existing_survivors', 'contained_requirements', 'qualified_dependencies','contact_paraphrases']);
const isActionOnlySemanticScope = scope => ACTION_SCOPES.has(scope);
const MODES = new Set(['off', 'shadow', 'on']);
function bounded(value, fallback, low, high) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.max(low, Math.min(high, Math.floor(number))) : fallback;
}
function normaliseSemanticPolicy(value) {
  if (!value || value.version !== SEMANTIC_POLICY_VERSION || value.taskVersion !== SEMANTIC_TASK_VERSION) {
    return Object.freeze({ version: SEMANTIC_POLICY_VERSION, taskVersion: SEMANTIC_TASK_VERSION,
      mode: 'off', maxCandidates: 64, batchSize: 4, budgetMs: 90000, attemptTimeoutMs: 60000 });
  }
  const narrow = value.contactReviews===true || value.contactParaphrases===true || value.containedRequirements===true || value.qualifiedDependencies===true || ['bounded_existing_survivors','contact_and_existing_survivors','contained_requirements','qualified_dependencies'].includes(value.scope);
  return Object.freeze({ version: SEMANTIC_POLICY_VERSION, taskVersion: SEMANTIC_TASK_VERSION,
    mode: MODES.has(value.mode) && (value.scope === undefined || ACTION_SCOPES.has(value.scope)) ? value.mode : 'off',
    maxCandidates: bounded(value.maxCandidates, ['contained_requirements','qualified_dependencies','contact_paraphrases'].includes(value.scope) ? 1 : narrow ? 2 : 64, 1, ['contained_requirements','qualified_dependencies','contact_paraphrases'].includes(value.scope) ? 1 : narrow ? 2 : 128),
    batchSize: bounded(value.batchSize, 4, 1, 8),
    budgetMs: bounded(value.budgetMs, 90000, 10000, narrow ? 90000 : 180000),
    attemptTimeoutMs: bounded(value.attemptTimeoutMs, 60000, 10000, narrow ? 60000 : 90000),
    ...(ACTION_SCOPES.has(value.scope) ? { scope: value.scope } : {}),
    ...(ACTION_SCOPES.has(value.scope)&&value.containedRequirements===true?{containedRequirements:true}:{}),
    ...(ACTION_SCOPES.has(value.scope)&&value.containedRequirements===true&&value.exactInstructionRepeats===true?{exactInstructionRepeats:true}:{}),
    ...(ACTION_SCOPES.has(value.scope)&&value.qualifiedDependencies===true?{qualifiedDependencies:true}:{}),
    ...(ACTION_SCOPES.has(value.scope)&&value.referenceContracts===true?{referenceContracts:true}:{}),
    ...(ACTION_SCOPES.has(value.scope)&&value.compilationUnions===true?{compilationUnions:true}:{}),
    ...(ACTION_SCOPES.has(value.scope)&&value.phaseClarifications===true?{phaseClarifications:true}:{}),
    ...(ACTION_SCOPES.has(value.scope)&&value.contactParaphrases===true?{contactParaphrases:true}:{}),
    ...(ACTION_SCOPES.has(value.scope)&&value.contactReviews===true&&value.contactParaphrases===true?{contactReviews:true}:{}) });
}
function captureSemanticPolicy(env = process.env) {
  const broadMode = String(env.MEETING_MINUTES_AGENT_SEMANTIC_RECONCILIATION_V1 || 'off').trim().toLowerCase();
  const enquiries = broadMode === 'off' && /^(?:1|true|yes|on)$/i.test(String(env.MEETING_MINUTES_AGENT_CONTACT_ENQUIRY_DEDUPE_V1 || '0'));
  const survivors = broadMode === 'off' && /^(?:1|true|yes|on)$/i.test(String(env.MEETING_MINUTES_AGENT_BOUNDED_SURVIVOR_DEDUPE_V1 || '0'));
  const contained = broadMode === 'off' && /^(?:1|true|yes|on)$/i.test(String(env.MEETING_MINUTES_AGENT_CONTAINED_REQUIREMENTS_V1 || '0'));
  const contactReviews = broadMode === 'off' && /^(?:1|true|yes|on)$/i.test(String(env.MEETING_MINUTES_AGENT_CONTACT_REVIEW_V1 || '0'));
  const contacts = contactReviews || broadMode === 'off' && /^(?:1|true|yes|on)$/i.test(String(env.MEETING_MINUTES_AGENT_CONTACT_PARAPHRASE_V1 || '0'));
  const dependencies = broadMode === 'off' && /^(?:1|true|yes|on)$/i.test(String(env.MEETING_MINUTES_AGENT_QUALIFIED_DEPENDENCY_DEDUPE_V1 || '0'));
  const scope = survivors ? (enquiries ? 'contact_and_existing_survivors' : 'bounded_existing_survivors') : (enquiries?'contact_enquiries':contained?'contained_requirements':dependencies?'qualified_dependencies':'contact_paraphrases');
  return normaliseSemanticPolicy({ version: SEMANTIC_POLICY_VERSION, taskVersion: SEMANTIC_TASK_VERSION,
    mode: enquiries || survivors || contained || dependencies || contacts ? 'on' : broadMode,
    ...(enquiries || survivors || contained || dependencies || contacts ? { scope } : {}),
    ...(contained?{containedRequirements:true}:{}),
    ...(dependencies?{qualifiedDependencies:true}:{}),
    ...(contacts?{contactParaphrases:true}:{}),
    ...(contactReviews?{contactReviews:true}:{}),
    exactInstructionRepeats:contained&&/^(?:1|true|yes|on)$/i.test(String(env.MEETING_MINUTES_AGENT_EXACT_INSTRUCTION_REPEAT_V1||'0')),
    compilationUnions:/^(?:1|true|yes|on)$/i.test(String(env.MEETING_MINUTES_AGENT_COMPILATION_UNION_V1||'0')),
    phaseClarifications:/^(?:1|true|yes|on)$/i.test(String(env.MEETING_MINUTES_AGENT_PHASE_CLARIFICATION_V1||'0')),
    referenceContracts:/^(?:1|true|yes|on)$/i.test(String(env.MEETING_MINUTES_AGENT_ACTION_PROOF_CONTRACT_V2||'0')),
    maxCandidates: enquiries || survivors ? 2 : contained || dependencies || contacts ? 1 : env.MEETING_MINUTES_AGENT_SEMANTIC_MAX_CANDIDATES,
    batchSize: env.MEETING_MINUTES_AGENT_SEMANTIC_BATCH_SIZE,
    budgetMs: env.MEETING_MINUTES_AGENT_SEMANTIC_BUDGET_MS,
    attemptTimeoutMs: env.MEETING_MINUTES_AGENT_SEMANTIC_TIMEOUT_MS });
}
function semanticPolicyForRun(draft = {}, explicit) {
  return normaliseSemanticPolicy(explicit ?? draft._semanticPolicy ?? draft.generation?.semanticPolicy);
}
function semanticPolicyForFingerprint(draft = {}) {
  // Active legacy work stays legacy. Idle drafts are compared with the policy
  // a new job would capture, preventing adoption of a differently configured
  // speculative result after a flag or budget change.
  if (draft.generation?.status === 'running' || draft._semanticPolicy) return semanticPolicyForRun(draft);
  return captureSemanticPolicy();
}
module.exports = { SEMANTIC_POLICY_VERSION, SEMANTIC_TASK_VERSION, normaliseSemanticPolicy,
  isActionOnlySemanticScope, captureSemanticPolicy, semanticPolicyForRun, semanticPolicyForFingerprint };
