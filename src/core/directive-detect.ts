/**
 * Directive-shape detection for profile candidates.
 *
 * Why this exists
 * ---------------
 * A user-profile entry that *describes* the person is safe to maintain
 * automatically. An entry that *instructs the agent* is not: it is injected into
 * every session on the machine, and a hallucinated behavioural rule ("accepts
 * commits without tests") changes what the agent does everywhere. Magic
 * Context promoted both kinds automatically — its only gate was a pool-size
 * count, and the "at least N semantically similar variants" requirement lived
 * in the prompt with no code behind it. Of the 17 live profile rows two thirds
 * turned out to be behavioural rules.
 *
 * So: directive-shaped content must be confirmed by a human before it can take
 * effect. This module decides WHICH candidates have to ask.
 *
 * The error asymmetry is the whole design:
 *   - a false POSITIVE costs one question (annoying, safe);
 *   - a false NEGATIVE lets an unreviewed rule into every session (the failure
 *     this exists to prevent).
 * The rule set is therefore built to over-trigger, and the regression suite
 * (tests/directive-detect.spec.ts) requires ZERO misses on the labelled corpus
 * while merely BOUNDING the harmless direction.
 *
 * A second signal keeps the noise down: an obligation is only directive-shaped
 * when it targets something an agent can DO. "Not accepting a downstream
 * fallback for data problems" is an attitude (descriptive); "must discuss in
 * plan mode before writing any file" is an instruction.
 */

export type ProfileShape = 'descriptive' | 'directive'

export type DirectiveRuleKind = 'hard' | 'soft' | 'action'

export interface DirectiveRuleHit {
  readonly rule: string
  readonly kind: DirectiveRuleKind
  /** The matched substring, for the confirmation question and the journal. */
  readonly match: string
}

export interface ProfileShapeVerdict {
  readonly shape: ProfileShape
  /** Weighted obligation score; `>= DIRECTIVE_SCORE_THRESHOLD` with an action cue. */
  readonly score: number
  readonly hits: readonly DirectiveRuleHit[]
  /** Human-readable reasons (rule names), for the "why we are asking" notice. */
  readonly reasons: readonly string[]
}

/** An obligation must reach this weight before the shape is directive. */
export const DIRECTIVE_SCORE_THRESHOLD = 2

interface Rule {
  readonly rule: string
  readonly weight: number
  readonly pattern: RegExp
}

/** Obligations strong enough to stand alone. */
const HARD_RULES: readonly Rule[] = [
  { rule: 'obligation:必须', weight: 2, pattern: /必须/ },
  { rule: 'obligation:务必', weight: 2, pattern: /务必/ },
  { rule: 'prohibition:严禁', weight: 2, pattern: /严禁/ },
  { rule: 'prohibition:禁止', weight: 2, pattern: /禁止/ },
  { rule: 'prohibition:不得', weight: 2, pattern: /不得/ },
  { rule: 'prohibition:不允许', weight: 2, pattern: /不允许/ },
  { rule: 'prohibition:不可以', weight: 2, pattern: /不可以/ },
  { rule: 'obligation:一律', weight: 2, pattern: /一律/ },
  { rule: 'obligation:只能', weight: 2, pattern: /只能/ },
  { rule: 'gate:未确认前不', weight: 2, pattern: /未[^。；]{0,12}前不/ },
  { rule: 'gate:放行门禁', weight: 2, pattern: /放行门禁/ },
  { rule: 'obligation:en-must', weight: 2, pattern: /\bmust\b/i },
  { rule: 'prohibition:en-never', weight: 2, pattern: /\bnever\b/i },
  { rule: 'obligation:en-always', weight: 2, pattern: /\balways\b/i },
  { rule: 'prohibition:en-do-not', weight: 2, pattern: /\bdo not\b/i },
  { rule: 'obligation:en-required-to', weight: 2, pattern: /\brequired to\b/i },
  { rule: 'gate:en-before-doing', weight: 2, pattern: /\bbefore (writing|making|committing|pushing|deploying|changing|running)/i },
]

/**
 * Requirements that carry weight only together or with an explicit gate. The
 * `要求…先/再/才` shape is the most valuable one: it describes a process the
 * agent must follow, which is exactly what a directive is.
 */
const SOFT_RULES: readonly Rule[] = [
  { rule: 'requirement:要求…先/再/才/不要', weight: 2, pattern: /要求[^。；]{0,20}(先|再|才|必须|不要|不得)/ },
  { rule: 'refusal:拒绝…任何/用', weight: 2, pattern: /拒绝[^。；]{0,12}(任何|用)/ },
  { rule: 'refusal:不接受…兜底/妥协/凑数', weight: 2, pattern: /不接受[^。；]{0,12}(兜底|妥协|凑数)/ },
  { rule: 'insistence:坚持…以/把…作为/为准', weight: 1, pattern: /坚持[^。；]{0,12}(以|把)[^。；]{0,24}(作为|为准)/ },
  { rule: 'process:强制', weight: 1, pattern: /强制/ },
  { rule: 'process:严格执行', weight: 1, pattern: /严格执行/ },
  { rule: 'process:严格顺序', weight: 1, pattern: /严格顺序/ },
]

/**
 * Something an agent can do. An obligation that targets none of these is about
 * the world (a standard, a preference, a data-quality stance), not an
 * instruction to the agent.
 */
const ACTION_RULES: readonly Rule[] = [
  { rule: 'action:写文件/代码', weight: 0, pattern: /写(文件|代码)/ },
  { rule: 'action:推送', weight: 0, pattern: /推送/ },
  { rule: 'action:提交', weight: 0, pattern: /提交/ },
  { rule: 'action:部署', weight: 0, pattern: /部署/ },
  { rule: 'action:修复', weight: 0, pattern: /修复/ },
  { rule: 'action:删除', weight: 0, pattern: /删除/ },
  { rule: 'action:提醒/提示', weight: 0, pattern: /提醒|提示|通知/ },
  { rule: 'action:报告/汇报', weight: 0, pattern: /报告|汇报/ },
  { rule: 'action:运行/执行', weight: 0, pattern: /运行|执行/ },
  { rule: 'action:测试/验证', weight: 0, pattern: /测试|验证/ },
  { rule: 'action:落地/推进', weight: 0, pattern: /落地|推进/ },
  { rule: 'action:确认/核对', weight: 0, pattern: /确认|核对|核实/ },
  { rule: 'action:评估', weight: 0, pattern: /评估/ },
  { rule: 'action:清理/删除', weight: 0, pattern: /清理/ },
  { rule: 'action:保持/避免', weight: 0, pattern: /保持|避免/ },
  { rule: 'action:遵循/遵守', weight: 0, pattern: /遵循|遵守/ },
  { rule: 'action:备份/安装/配置', weight: 0, pattern: /备份|安装|配置/ },
  { rule: 'action:切换/回退', weight: 0, pattern: /切换|回退|切回/ },
  { rule: 'action:en-verb', weight: 0, pattern: /\b(run|push|commit|test|write|delete|deploy|verify|confirm|wait|backup|review|ensure|check|update|refactor)\b/i },
]

const ALL_RULES: readonly Rule[] = [...HARD_RULES, ...SOFT_RULES, ...ACTION_RULES]

function kindOf(rule: Rule): DirectiveRuleKind {
  if (HARD_RULES.includes(rule)) return 'hard'
  if (SOFT_RULES.includes(rule)) return 'soft'
  return 'action'
}

/** Every rule that fires, in declaration order, with the matched text. */
export function detectDirectiveHits(text: string): DirectiveRuleHit[] {
  const hits: DirectiveRuleHit[] = []
  for (const rule of ALL_RULES) {
    const match = rule.pattern.exec(text)
    if (match !== null) {
      hits.push({ rule: rule.rule, kind: kindOf(rule), match: match[0] })
    }
  }
  return hits
}

/**
 * Classify one profile candidate. Conservative by construction: the shape is
 * `directive` when the obligation weight reaches the threshold AND at least one
 * action cue is present.
 */
export function classifyProfileShape(text: string): ProfileShapeVerdict {
  const hits = detectDirectiveHits(text)
  const weightOf = (rule: string): number => ALL_RULES.find(candidate => candidate.rule === rule)?.weight ?? 0
  const score = hits.reduce((total, hit) => total + weightOf(hit.rule), 0)
  const hasAction = hits.some(hit => hit.kind === 'action')
  const shape: ProfileShape = score >= DIRECTIVE_SCORE_THRESHOLD && hasAction ? 'directive' : 'descriptive'
  return {
    shape,
    score,
    hits,
    reasons: hits.map(hit => hit.rule),
  }
}

export function isDirectiveShaped(text: string): boolean {
  return classifyProfileShape(text).shape === 'directive'
}

/**
 * The question a directive-shaped candidate has to answer before it may enter
 * the profile. It states the blast radius, because that is what the human is
 * actually deciding about.
 */
export function buildConfirmationQuestion(content: string, verdict: ProfileShapeVerdict): string {
  const why = verdict.hits.filter(hit => hit.kind !== 'action').map(hit => hit.rule).join(', ')
  return [
    '一条画像候选读起来像**行为指令**，而不是对使用者的描述。',
    `候选内容：${content}`,
    why === '' ? '' : `判定依据：${why}`,
    '确认后它会在**所有会话**中生效（不分项目）。',
    '请回复：确认 / 改为描述型 / 丢弃。',
  ].filter(line => line !== '').join('\n')
}
