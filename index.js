/**
 * Host half of dsh-prompt-enhancer.
 *
 * Registers two human commands that run ONE auxiliary model call over a
 * composer draft:
 *
 *   /enhance        text result: the rewritten prompt plus open questions
 *   /enhance-quiet  JSON result (`{"prompt","gaps","added"}`) for the ✨ button
 *
 * This module deliberately has ZERO imports: the package is linked from a
 * local directory into a dsh profile, where bare `@deepseek-ai/*` specifiers
 * may not resolve. Everything below is plain ESM plus the `ctx` services that
 * dsh-base already composes (`commands`, `llm`).
 *
 * Everything is defensive: a command handler must always settle to a
 * `CommandResult` and never throw.
 *
 * Model route: the enhancement call FOLLOWS THE CURRENT SESSION MODEL by
 * default (the `modelSelection` session projection: a just-picked but not yet
 * sent model first, then the model the session last used), falling back to the
 * session's logged request route, the agent's options, and the profile default.
 * Pinning `provider` + `model` together in the row config opts out of that and
 * always uses the pinned pair.
 */

export const name = 'prompt-enhancer';
export const inject = ['commands', 'llm'];

/** Command names share the registry's grammar. */
const COMMAND_NAME_RE = /^[a-z][a-z0-9_-]*$/u;
/** Largest delay `AbortSignal.timeout()` accepts without a RangeError. */
const MAX_TIMER_DELAY_MS = 2147483647;
/** Longest single open question kept in a result. */
const MAX_GAP_CHARS = 200;
/** Most open questions kept in a result. */
const MAX_GAPS = 5;

const DEFAULT_SYSTEM_PROMPT = [
  'You enhance a draft prompt that a user is about to send to an AI coding assistant.',
  'Return ONLY one JSON object, with no Markdown fence and no commentary, exactly in this shape:',
  '{"prompt": string, "gaps": string[], "added": string}',
  'Rules:',
  '- "prompt" is the rewritten prompt, ready to send as-is. Preserve the original intent, language, and facts.',
  '- Never invent facts, files, versions, requirements, or constraints that the draft does not state.',
  '- "gaps" lists 2-5 pieces of information the draft omits but a strong prompt would benefit from (for example target files, environment, acceptance criteria). Each item is at most 60 characters. Use [] when nothing is genuinely missing.',
  '- "added" is one short sentence describing the structure or clarifications you added; use "" when you added nothing.',
  '- If the draft is already clear and complete, tighten it only lightly, keep gaps empty, and do not pad it.',
  '- Match the language of the draft.',
].join('\n');

const DEFAULT_TEMPLATE = 'Draft:\n<<<\n{{draft}}\n>>>';

const DEFAULTS = Object.freeze({
  commandName: 'enhance',
  quietCommandName: 'enhance-quiet',
  provider: '',
  model: '',
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  template: DEFAULT_TEMPLATE,
  maxInputChars: 4000,
  maxOutputTokens: 1024,
  timeoutMs: 60000,
});

/* ------------------------------------------------------------------------- */
/* Configuration                                                             */
/* ------------------------------------------------------------------------- */

/** Keep a positive safe integer, otherwise use the default. */
function positiveInteger(value, fallback, max) {
  const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  if (!Number.isInteger(number) || number < 1 || number > (max ?? Number.MAX_SAFE_INTEGER)) return fallback;
  return number;
}

/** Keep a non-empty string, otherwise use the default. */
function nonEmptyString(value, fallback) {
  if (typeof value !== 'string') return fallback;
  return value.trim().length === 0 ? fallback : value;
}

/** Keep a valid command name, otherwise use the default. */
function validCommandName(value, fallback) {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return COMMAND_NAME_RE.test(trimmed) ? trimmed : fallback;
}

/**
 * Turn the raw Loader row config into a complete, validated policy.
 *
 * The plugin intentionally exports no `Config` schema (a schemastery schema
 * would require an import), so cordis passes the raw row config through
 * unchanged: `resolveConfig()` returns it as-is when the runtime has no
 * `Config` (`@deepseek-ai/cordis` lib/index.js: `if (!runtime.Config) return
 * config`). Defaults and type validation therefore live here.
 *
 * @param {unknown} raw untrusted row config (may be undefined).
 * @returns {typeof DEFAULTS} a complete policy.
 */
function normalizeConfig(raw) {
  const source = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const commandName = validCommandName(source.commandName, DEFAULTS.commandName);
  let quietCommandName = validCommandName(source.quietCommandName, DEFAULTS.quietCommandName);
  if (quietCommandName === commandName) quietCommandName = DEFAULTS.quietCommandName === commandName ? 'enhance-quiet' : DEFAULTS.quietCommandName;
  if (quietCommandName === commandName) quietCommandName = commandName + '-quiet';
  return {
    commandName,
    quietCommandName,
    provider: nonEmptyString(source.provider, DEFAULTS.provider).trim(),
    model: nonEmptyString(source.model, DEFAULTS.model).trim(),
    systemPrompt: nonEmptyString(source.systemPrompt, DEFAULTS.systemPrompt),
    template: nonEmptyString(source.template, DEFAULTS.template),
    maxInputChars: positiveInteger(source.maxInputChars, DEFAULTS.maxInputChars),
    maxOutputTokens: positiveInteger(source.maxOutputTokens, DEFAULTS.maxOutputTokens),
    timeoutMs: positiveInteger(source.timeoutMs, DEFAULTS.timeoutMs, MAX_TIMER_DELAY_MS),
  };
}

/* ------------------------------------------------------------------------- */
/* Errors (bilingual: expected failures are user-facing)                     */
/* ------------------------------------------------------------------------- */

const ERROR_EMPTY_INPUT = '请输入要增强的内容。 / Type something to enhance.';
const ERROR_NO_ROUTE =
  '未找到可用模型：请在插件配置中成对设置 provider/model，或先发送一条消息后重试。 / No model route: set provider/model together in the plugin config, or send one message first and retry.';
const ERROR_LLM_UNAVAILABLE = 'LLM 服务不可用。 / The LLM service is unavailable.';
const ERROR_CANCELLED = '增强已取消。 / Enhancement cancelled.';
const ERROR_EMPTY_OUTPUT = '模型没有返回可用内容。 / The model returned no usable text.';
const ERROR_TOOL_CALLS = '模型意外请求了工具。 / The model unexpectedly requested a tool.';

/** Too-long draft error. */
function errorTooLong(length, max) {
  return `草稿过长：${length} 字符，超过上限 ${max}。 / Draft is too long: ${length} characters (limit ${max}).`;
}

/** Output-token cap error. */
function errorMaxTokens(max) {
  return `输出达到 maxOutputTokens 上限（${max}）。 / Output reached the maxOutputTokens limit (${max}).`;
}

/** Timeout error. */
function errorTimeout(ms) {
  return `增强超时（${ms}ms）。 / Enhancement timed out after ${ms}ms.`;
}

/** Provider/stream failure with the stable code kept visible. */
function errorModelFailure(code, message) {
  const detail = [code, message].filter((part) => typeof part === 'string' && part.length > 0).join(': ');
  const suffix = detail.length > 0 ? detail : 'unknown failure';
  return `模型调用失败 / Model call failed: ${suffix}`;
}

/** Render any thrown value without trusting its string coercion. */
function describeError(error) {
  if (error instanceof Error) return error.message.length > 0 ? error.message : error.name;
  try {
    return String(error);
  } catch {
    return '<unrenderable error>';
  }
}

/* ------------------------------------------------------------------------- */
/* Route resolution                                                          */
/* ------------------------------------------------------------------------- */

/** Read a provider/model pair from a route-shaped value. */
function asRoute(value) {
  if (value === null || typeof value !== 'object') return undefined;
  const candidates = [value, value.selection, value.config];
  for (const candidate of candidates) {
    if (candidate === null || typeof candidate !== 'object') continue;
    const provider = candidate.provider;
    const model = candidate.model;
    if (typeof provider === 'string' && provider.length > 0 && typeof model === 'string' && model.length > 0) {
      return { provider, model };
    }
  }
  return undefined;
}

/**
 * Read the model the Session currently has selected, i.e. what the composer
 * model picker shows: the pending selection intent first, then the model the
 * last request actually used. Both live in the `modelSelection` Session
 * projection (`@deepseek-ai/dsh-api-session-controller`), which is the same
 * source the Host session controller reads for its own call routing.
 *
 * @param {any} ctx Host context (may expose the optional `sessionProjections` service).
 * @param {any} invocation command invocation (its `agent.session` is the durable Session).
 * @returns {{provider: string, model: string, source: string} | undefined}
 */
function sessionSelectionRoute(ctx, invocation) {
  const session = invocation?.agent?.session;
  if (session === null || typeof session !== 'object') return undefined;
  try {
    const projections = typeof ctx?.get === 'function' ? ctx.get('sessionProjections') : undefined;
    if (projections === null || typeof projections !== 'object' || typeof projections.stateOf !== 'function') return undefined;
    const state = projections.stateOf(session, 'modelSelection');
    if (state === null || typeof state !== 'object') return undefined;
    const pending = asRoute(state.pending);
    if (pending !== undefined) return { ...pending, source: 'session-selection-pending' };
    const lastUsed = asRoute(state.lastUsed);
    if (lastUsed !== undefined) return { ...lastUsed, source: 'session-selection-last-used' };
  } catch {
    /* defensive: an older harness may not register the projection */
  }
  return undefined;
}

/**
 * Resolve the model route for one enhancement call, in order:
 *   1. the plugin config's provider+model pair (explicit pin wins);
 *   2. the Session's current model selection (`modelSelection` projection:
 *      pending pick first, then last used) — this is "follow the current
 *      session model", so clicking ✨ right after switching models uses the
 *      newly picked one;
 *   3. the route logged by the session's last request (`request/header`);
 *   4. the agent's own options;
 *   5. the composed default model selection (`ctx.agentDefaultModel`).
 *
 * @returns {{provider: string, model: string, source: string} | undefined}
 */
function resolveRoute(ctx, invocation, config) {
  if (config.provider.length > 0 && config.model.length > 0) {
    return { provider: config.provider, model: config.model, source: 'config' };
  }
  const selected = sessionSelectionRoute(ctx, invocation);
  if (selected !== undefined) return selected;
  try {
    const route = asRoute(invocation?.agent?.session?.requestHeader?.());
    if (route !== undefined) return { ...route, source: 'session-header' };
  } catch {
    /* defensive: a session without a folded header must not fail the command */
  }
  try {
    const route = asRoute(invocation?.agent?.options);
    if (route !== undefined) return { ...route, source: 'agent-options' };
  } catch {
    /* defensive: an agent whose creation options were discarded must not fail */
  }
  try {
    const service = typeof ctx?.get === 'function' ? ctx.get('agentDefaultModel') : undefined;
    const route = asRoute(service?.currentSelection?.());
    if (route !== undefined) return { ...route, source: 'default-model' };
  } catch {
    /* defensive: the optional service may be absent or still booting */
  }
  return undefined;
}

/* ------------------------------------------------------------------------- */
/* Result parsing                                                            */
/* ------------------------------------------------------------------------- */

/** Keep only useful string gaps, capped in count and length. */
function normalizeGaps(value) {
  if (!Array.isArray(value)) return [];
  const gaps = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const gap = item.trim();
    if (gap.length === 0) continue;
    gaps.push(gap.length > MAX_GAP_CHARS ? gap.slice(0, MAX_GAP_CHARS) : gap);
    if (gaps.length >= MAX_GAPS) break;
  }
  return gaps;
}

/** Coerce `added` to a string. */
function normalizeAdded(value) {
  if (typeof value === 'string') return value.trim();
  if (value === undefined || value === null) return '';
  try {
    return String(value);
  } catch {
    return '';
  }
}

/**
 * Parse the model output into `{prompt, gaps, added}`.
 *
 * Tolerates ```json fences and surrounding prose, but never fails: when the
 * payload is not usable JSON with a non-empty prompt, the trimmed full output
 * becomes the prompt.
 *
 * @param {string} raw accumulated text-delta output.
 * @returns {{prompt: string, gaps: string[], added: string}}
 */
function parseResult(raw) {
  const text = String(raw ?? '').trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/iu.exec(text);
  let candidate = fenced !== null && typeof fenced[1] === 'string' ? fenced[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start !== -1 && end > start) candidate = candidate.slice(start, end + 1);
  try {
    const parsed = JSON.parse(candidate);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const prompt = typeof parsed.prompt === 'string' ? parsed.prompt.trim() : '';
      if (prompt.length > 0) {
        return { prompt, gaps: normalizeGaps(parsed.gaps), added: normalizeAdded(parsed.added) };
      }
    }
  } catch {
    /* fall through to the whole-text fallback */
  }
  return { prompt: text, gaps: [], added: '' };
}

/* ------------------------------------------------------------------------- */
/* Model call                                                                */
/* ------------------------------------------------------------------------- */

/**
 * One-shot enhancement over the invocation draft.
 *
 * @param {any} ctx Host context exposing `llm` (and optionally `agentDefaultModel`).
 * @param {{rawInput?: string, signal?: AbortSignal, agent?: any}} invocation command invocation.
 * @param {unknown} rawConfig raw Loader row config.
 * @returns {Promise<
 *   {ok: true, prompt: string, gaps: string[], added: string, route: {provider: string, model: string, source: string}} |
 *   {ok: false, error: string}
 * >} never rejects for expected failures. `route` is diagnostic: the command
 *   handlers ignore it, while tests and logs can see which model was used.
 */
export async function enhance(ctx, invocation, rawConfig) {
  const config = normalizeConfig(rawConfig);
  const draft = String(invocation?.rawInput ?? '').trim();
  if (draft.length === 0) return { ok: false, error: ERROR_EMPTY_INPUT };
  if (draft.length > config.maxInputChars) return { ok: false, error: errorTooLong(draft.length, config.maxInputChars) };

  const route = resolveRoute(ctx, invocation, config);
  if (route === undefined) return { ok: false, error: ERROR_NO_ROUTE };

  const llm = ctx?.llm;
  if (llm === null || typeof llm !== 'object' || typeof llm.stream !== 'function') {
    return { ok: false, error: ERROR_LLM_UNAVAILABLE };
  }

  const timeoutSignal = AbortSignal.timeout(config.timeoutMs);
  const sourceSignal = invocation?.signal;
  const signal =
    sourceSignal !== null && typeof sourceSignal === 'object' && typeof sourceSignal.aborted === 'boolean'
      ? AbortSignal.any([sourceSignal, timeoutSignal])
      : timeoutSignal;
  const userText = config.template.split('{{draft}}').join(draft);

  let rawText = '';
  let finish;
  try {
    const stream = llm.stream({
      provider: route.provider,
      model: route.model,
      messages: [{ role: 'user', content: [{ type: 'text', text: userText }] }],
      system: config.systemPrompt,
      maxTokens: config.maxOutputTokens,
      signal,
    });
    for await (const chunk of stream) {
      if (chunk === null || typeof chunk !== 'object') continue;
      if (chunk.type === 'text-delta') {
        if (typeof chunk.text === 'string') rawText += chunk.text;
      } else if (chunk.type === 'finish') {
        finish = chunk.reason;
      }
    }
  } catch (error) {
    return { ok: false, error: classifyStreamFailure(error, invocation, timeoutSignal, config) };
  }

  // A stream that ends without a terminal finish after cancellation must not
  // be mistaken for a completed result.
  if (sourceSignal !== null && typeof sourceSignal === 'object' && sourceSignal.aborted === true) {
    return { ok: false, error: ERROR_CANCELLED };
  }
  if (timeoutSignal.aborted === true) return { ok: false, error: errorTimeout(config.timeoutMs) };

  const failure = classifyFinish(finish, invocation, timeoutSignal, config);
  if (failure !== undefined) return { ok: false, error: failure };

  const text = rawText.trim();
  if (text.length === 0) return { ok: false, error: ERROR_EMPTY_OUTPUT };
  const result = parseResult(text);
  if (result.prompt.length === 0) return { ok: false, error: ERROR_EMPTY_OUTPUT };
  return { ok: true, ...result, route: { provider: route.provider, model: route.model, source: route.source } };
}

/** Classify a terminal finish chunk, or undefined when it is a clean stop. */
function classifyFinish(reason, invocation, timeoutSignal, config) {
  const kind = reason !== null && typeof reason === 'object' ? reason.kind : undefined;
  if (kind === undefined) return undefined; // tolerate a stream that ended without a finish chunk
  if (kind === 'stop') return undefined;
  if (kind === 'max-tokens') return errorMaxTokens(config.maxOutputTokens);
  if (kind === 'tool-calls') return ERROR_TOOL_CALLS;
  if (kind === 'aborted' || kind === 'error') {
    if (invocation?.signal?.aborted === true) return ERROR_CANCELLED;
    if (timeoutSignal.aborted === true) return errorTimeout(config.timeoutMs);
    const failure = reason !== null && typeof reason === 'object' && reason.failure !== null && typeof reason.failure === 'object' ? reason.failure : {};
    return errorModelFailure(failure.code, failure.message);
  }
  return errorModelFailure(undefined, `unexpected finish "${String(kind)}"`);
}

/** Classify a thrown stream/iteration failure. */
function classifyStreamFailure(error, invocation, timeoutSignal, config) {
  if (invocation?.signal?.aborted === true) return ERROR_CANCELLED;
  if (timeoutSignal.aborted === true) return errorTimeout(config.timeoutMs);
  const code = error !== null && typeof error === 'object' && typeof error.code === 'string' ? error.code : undefined;
  return errorModelFailure(code, describeError(error));
}

/* ------------------------------------------------------------------------- */
/* Result formatting                                                         */
/* ------------------------------------------------------------------------- */

/** Whether text contains CJK characters (used only to pick a section label). */
function looksChinese(text) {
  return /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/u.test(String(text ?? ''));
}

/**
 * Format a successful result for the text command:
 * prompt, then a "To confirm"/"待确认" section when gaps exist.
 *
 * @param {{prompt?: string, gaps?: string[]}} result parsed result.
 * @param {boolean} zh use the Chinese section label.
 * @returns {string}
 */
export function formatTextForTextCommand(result, zh) {
  const prompt = typeof result?.prompt === 'string' ? result.prompt : '';
  const gaps = Array.isArray(result?.gaps) ? result.gaps.filter((gap) => typeof gap === 'string' && gap.trim().length > 0) : [];
  if (gaps.length === 0) return prompt;
  const label = zh === true ? '待确认' : 'To confirm';
  return prompt + '\n\n## ' + label + '\n' + gaps.map((gap) => '- ' + gap).join('\n');
}

/* ------------------------------------------------------------------------- */
/* Plugin lifecycle                                                          */
/* ------------------------------------------------------------------------- */

/** Track one handler promise so unload can drain it (mirrors /compact). */
function track(active, task) {
  active.add(task);
  const retire = () => {
    active.delete(task);
  };
  task.then(retire, retire);
  return task;
}

/** Build a handler that always settles to a CommandResult. */
function createHandler(ctx, config, active, mode) {
  return (invocation) => {
    const task = (async () => {
      try {
        const outcome = await enhance(ctx, invocation, config);
        if (!outcome.ok) return { kind: 'error', text: outcome.error };
        if (mode === 'json') {
          return { kind: 'success', text: JSON.stringify({ prompt: outcome.prompt, gaps: outcome.gaps, added: outcome.added }) };
        }
        const zh = looksChinese(outcome.prompt) || looksChinese(invocation?.rawInput);
        return { kind: 'success', text: formatTextForTextCommand(outcome, zh) };
      } catch (error) {
        // Defensive only: enhance() already classifies expected failures.
        return { kind: 'error', text: '增强失败 / Enhancement failed: ' + describeError(error) };
      }
    })();
    return track(active, task);
  };
}

/**
 * Register both human commands. The disposers ride one `ctx.effect` so a
 * plugin unload also drains handler promises that are still in flight.
 *
 * @param {any} ctx Host context (`commands`, `llm` injected).
 * @param {unknown} rawConfig raw Loader row config.
 */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig);
  const active = new Set();
  ctx.effect(function* promptEnhancerLifecycle() {
    yield async () => {
      await Promise.allSettled([...active]);
    };
    yield ctx.commands.register({
      name: config.commandName,
      description: '扩写输入框草稿为结构化提示词，并列出待确认项 / Expand the composer draft into a structured prompt with open questions.',
      input: { hint: '<draft>' },
      recordInput: false,
      handler: createHandler(ctx, config, active, 'text'),
    });
    yield ctx.commands.register({
      name: config.quietCommandName,
      description: '内部：✨ 按钮用的静默扩写（返回 JSON）/ Internal (composer button): silent JSON variant used by the ✨ control.',
      recordInput: false,
      handler: createHandler(ctx, config, active, 'json'),
    });
  }, 'prompt-enhancer lifecycle');
}
