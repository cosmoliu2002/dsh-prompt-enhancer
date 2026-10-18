/**
 * dsh-prompt-enhancer — browser half.
 *
 * Classic script (no import/export): registers one lazy factory into the dsh
 * client module table. The factory renders the ✨ composer control, the
 * per-session diagnosis strip under the composer, and hides the button-only
 * /enhance-quiet command card from the conversation transcript.
 *
 * Self-contained: only `react` comes from the module table. No host package
 * imports, no DOM reads other than the style tag this bundle owns.
 */
window.__ModuleLoader__.load({
	id: 'dsh-prompt-enhancer',
	factory: (require) => {
		const React = require('react');
		const h = React.createElement;

		/** Module-table id: also the style-ownership tag the host unload path uses. */
		const PLUGIN_ID = 'dsh-prompt-enhancer';
		/** Locale namespace owned by this plugin (dictionaries registered in apply). */
		const NS = 'promptEnhancer';
		/** Host command this control executes; the card renderer is keyed by it. */
		const COMMAND = 'enhance-quiet';

		// ── styles ─────────────────────────────────────────────────────────────
		// Injected while the factory materializes: the module system claims the
		// tag and removes it when this bundle is replaced or unloaded. Colors are
		// theme tokens only (host palette owns light/dark).
		const CSS = [
			'.dpeBtn{corner-shape:round;background:var(--dsw-specific-selector);width:28px;height:28px;',
			'color:var(--dsw-alias-label-primary);cursor:pointer;border:none;border-radius:999px;',
			'flex:none;place-items:center;display:grid;font-size:14px;line-height:1;padding:0}',
			'.dpeBtn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-solid)}',
			'.dpeBtn:disabled{opacity:.5;cursor:default}',
			'.dpeDock{box-sizing:border-box;width:100%;display:flex;flex-direction:column;gap:4px;',
			'padding:6px 10px;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-module-platform);',
			'color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}',
			'.dpeDockRow{display:flex;align-items:flex-start;gap:8px;min-width:0}',
			'.dpeDockText{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis}',
			'.dpeDockGaps{color:var(--dsw-alias-label-tertiary);word-break:break-word}',
			'.dpeDockFailed{color:var(--dsw-alias-state-error-primary)}',
			'.dpeDockClose{flex:none;display:grid;place-items:center;width:18px;height:18px;padding:0;',
			'border:none;border-radius:var(--dsw-radius-xs);background:transparent;color:inherit;',
			'cursor:pointer;font-size:12px;line-height:1}',
			'.dpeDockClose:hover{background:var(--dsw-alias-interactive-bg-hover)}',
			'.dpeDockAction{flex:none;padding:0 4px;border:none;border-radius:var(--dsw-radius-xs);',
			'background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;',
			'font-size:12px;line-height:18px;text-decoration:underline;text-underline-offset:2px}',
			'.dpeDockAction:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
		].join('');
		if (typeof document !== 'undefined' && document.querySelector('style[data-plugin="' + PLUGIN_ID + '"]') === null) {
			const styleTag = document.createElement('style');
			styleTag.dataset.plugin = PLUGIN_ID;
			styleTag.dataset.pluginCss = PLUGIN_ID + '/client.css';
			styleTag.textContent = CSS;
			document.head.append(styleTag);
		}

		// ── dictionaries (zh/en key sets are identical) ────────────────────────
		const zh = {
			'button.enhance': '增强提示词',
			'button.enhancing': '增强中…',
			'error.remoteUnavailable': '宿主能力尚未就绪，暂时无法增强',
			'error.hostMissing': '宿主未注册 /{command} 命令',
			'error.emptyResult': '增强结果为空',
			'error.draftChanged': '草稿已变化，结果未写回',
			'error.unknown': '未知错误',
			'dock.done': '提示词已增强',
			'dock.added': '补充：{summary}',
			'dock.gaps': '{count} 处缺口',
			'dock.undo': '撤销',
			'dock.failed': '增强失败：{message}',
			'dock.dismiss': '关闭',
		};
		const en = {
			'button.enhance': 'Enhance prompt',
			'button.enhancing': 'Enhancing…',
			'error.remoteUnavailable': 'Host capability is not ready yet',
			'error.hostMissing': 'Host command /{command} is unavailable',
			'error.emptyResult': 'Enhance returned an empty prompt',
			'error.draftChanged': 'Draft changed; the result was not written back',
			'error.unknown': 'unknown error',
			'dock.done': 'Prompt enhanced',
			'dock.added': 'Added: {summary}',
			'dock.gaps': '{count} gaps',
			'dock.undo': 'Undo',
			'dock.failed': 'Enhance failed: {message}',
			'dock.dismiss': 'Dismiss',
		};

		// ── per-session diagnosis store ────────────────────────────────────────
		// One immutable snapshot object per session; a write replaces the object
		// so useSyncExternalStore observes a changed reference (and only then).
		/** @type {Map<string, {gaps: string[], added: string, error: string|null, seq: number}>} */
		const diagnoses = new Map();
		const diagnosisListeners = new Set();

		function diagnosisOf(sessionId) {
			return diagnoses.get(String(sessionId)) ?? null;
		}

		/**
		 * Publish one diagnosis snapshot for a session. `original` is the draft
		 * captured before the ✨ write, so the strip can restore it explicitly
		 * (reliable even where the editor's own undo history merges the seed).
		 * @param {string} sessionId - owning session.
		 * @param {string|null} error - error text, or null for a successful enhancement.
		 * @param {string[]} gaps - open questions reported by the host.
		 * @param {string} added - one-line summary of what the model added.
		 * @param {string} original - draft text before enhancement, or ''.
		 */
		function publishDiagnosis(sessionId, error, gaps, added, original) {
			const key = String(sessionId);
			diagnoses.set(key, {
				gaps: gaps,
				added: added,
				error: error,
				original: typeof original === 'string' ? original : '',
				seq: Date.now(),
			});
			for (const listener of [...diagnosisListeners]) {
				try {
					listener();
				} catch (_error) {
					// A subscriber failure must not undo the write.
				}
			}
		}

		function reportError(sessionId, message) {
			publishDiagnosis(sessionId, message, [], '', '');
		}

		function reportEnhancement(sessionId, gaps, added, original) {
			publishDiagnosis(sessionId, null, gaps, added, original);
		}

		function clearDiagnosis(sessionId) {
			diagnoses.delete(String(sessionId));
			for (const listener of [...diagnosisListeners]) {
				try {
					listener();
				} catch (_error) {
					// Same containment as publishDiagnosis.
				}
			}
		}

		function subscribeDiagnosis(listener) {
			diagnosisListeners.add(listener);
			return () => {
				diagnosisListeners.delete(listener);
			};
		}

		// ── result helpers ─────────────────────────────────────────────────────
		/**
		 * Parse the host command's result text. The contract is a JSON object
		 * `{prompt, gaps, added}`; plain text is accepted as a prompt-only result.
		 * @param {string} text - command result text.
		 * @returns {{prompt: string, gaps: string[], added: string}} normalized payload.
		 */
		function parseEnhancement(text) {
			let value;
			try {
				value = JSON.parse(text);
			} catch (_error) {
				value = undefined;
			}
			if (value === null || typeof value !== 'object' || Array.isArray(value)) {
				return { prompt: typeof text === 'string' ? text : '', gaps: [], added: '' };
			}
			const prompt = typeof value.prompt === 'string' ? value.prompt : '';
			const gaps = Array.isArray(value.gaps) ? value.gaps.filter((gap) => typeof gap === 'string') : [];
			const added = typeof value.added === 'string' ? value.added : '';
			return { prompt: prompt, gaps: gaps, added: added };
		}

		/**
		 * Human message of a RemoteResult failure branch.
		 * @param {unknown} result - resolved RemoteResult.
		 * @returns {string} failure message.
		 */
		function remoteFailureMessage(result) {
			if (result !== null && typeof result === 'object') {
				const failure = result.error;
				if (failure !== null && typeof failure === 'object' && typeof failure.message === 'string' && failure.message !== '') {
					return failure.message;
				}
			}
			return '';
		}

		// ── ✨ composer control ────────────────────────────────────────────────
		/**
		 * Toolbar control: reads the draft, calls the host command, writes the
		 * enhanced prompt back through the public input actions.
		 * @param {object} props - composed slot props (standard session kit + inject face + t).
		 * @returns {object} React element.
		 */
		function EnhanceButton(props) {
			const useInput = props.useInput;
			const inputActions = props.inputActions;
			const sessionId = props.sessionId;
			const t = props.t;
			const enhance = props.enhance;
			const draft = useInput((state) => state.draft);
			const phase = useInput((state) => state.phase);
			const draftRev = useInput((state) => state.draftRev);
			const [busy, setBusy] = React.useState(false);
			const busyRef = React.useRef(false);
			const composingRef = React.useRef(false);
			const [composing, setComposing] = React.useState(false);
			// Latest published input state, for the post-await revision compare.
			const live = React.useRef({ draft: draft, draftRev: draftRev });
			live.current = { draft: draft, draftRev: draftRev };

			React.useEffect(() => {
				const onCompositionStart = () => {
					composingRef.current = true;
					setComposing(true);
				};
				const onCompositionEnd = () => {
					composingRef.current = false;
					setComposing(false);
				};
				document.addEventListener('compositionstart', onCompositionStart, true);
				document.addEventListener('compositionend', onCompositionEnd, true);
				return () => {
					document.removeEventListener('compositionstart', onCompositionStart, true);
					document.removeEventListener('compositionend', onCompositionEnd, true);
				};
			}, []);

			const disabled = busy || phase !== 'plain' || composing || draft.trim() === '';

			const onClick = async () => {
				if (busyRef.current || composingRef.current || phase !== 'plain') return;
				const text = draft.trim();
				if (text === '') return;
				const captured = { draft: draft, draftRev: draftRev };
				busyRef.current = true;
				setBusy(true);
				try {
					const result = await enhance(text);
					if (result === null || typeof result !== 'object' || result.ok !== true) {
						const code = result !== null && typeof result === 'object' && result.error !== null && typeof result.error === 'object'
							? String(result.error.code)
							: '';
						reportError(
							sessionId,
							code === 'client/remote-unavailable'
								? t('error.remoteUnavailable')
								: remoteFailureMessage(result) || t('error.unknown'),
						);
						return;
					}
					if (result.value === undefined) {
						reportError(sessionId, t('error.hostMissing', { command: COMMAND }));
						return;
					}
					const outcome = result.value.result;
					if (outcome === null || typeof outcome !== 'object') {
						reportError(sessionId, t('error.unknown'));
						return;
					}
					if (outcome.kind === 'error') {
						reportError(sessionId, typeof outcome.text === 'string' && outcome.text !== '' ? outcome.text : t('error.unknown'));
						return;
					}
					const parsed = parseEnhancement(typeof outcome.text === 'string' ? outcome.text : '');
					if (parsed.prompt.trim() === '') {
						reportError(sessionId, t('error.emptyResult'));
						return;
					}
					const now = live.current;
					if (now.draft === captured.draft && now.draftRev === captured.draftRev) {
						inputActions.setDraft(parsed.prompt);
					} else if (inputActions.insertText(parsed.prompt, inputActions.captureInsertion()) !== true) {
						reportError(sessionId, t('error.draftChanged'));
						return;
					}
					reportEnhancement(sessionId, parsed.gaps, parsed.added, captured.draft);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					reportError(sessionId, message !== '' ? message : t('error.unknown'));
				} finally {
					busyRef.current = false;
					setBusy(false);
				}
			};

			const label = busy ? t('button.enhancing') : t('button.enhance');
			return h(
				'button',
				{
					type: 'button',
					className: 'dpeBtn',
					title: label,
					'aria-label': label,
					'aria-busy': busy || undefined,
					disabled: disabled,
					// Keep the composer's focus (and any in-flight IME composition).
					onMouseDown: (event) => event.preventDefault(),
					onClick: onClick,
				},
				h('span', { 'aria-hidden': true }, busy ? '…' : '✨'),
			);
		}

		// ── diagnosis strip (conversation.composer.dock) ───────────────────────
		/** Dismiss control shared by both strip states. */
		function dismissButton(t, sessionId) {
			return h(
				'button',
				{
					type: 'button',
					className: 'dpeDockClose',
					title: t('dock.dismiss'),
					'aria-label': t('dock.dismiss'),
					onClick: () => clearDiagnosis(sessionId),
				},
				'×',
			);
		}

		/**
		 * Per-session result strip: the last enhancement outcome (or failure).
		 * Renders nothing until the ✨ control reports for this session.
		 * @param {object} props - composed slot props (sessionId + t).
		 * @returns {object|null} React element or null.
		 */
		function DiagnosisStrip(props) {
			const sessionId = props.sessionId;
			const t = props.t;
			const inputActions = props.inputActions;
			const useInput = props.useInput;
			const draft = typeof useInput === 'function' ? useInput((state) => state.draft) : null;
			const entry = React.useSyncExternalStore(
				subscribeDiagnosis,
				() => diagnosisOf(sessionId),
				() => diagnosisOf(sessionId),
			);
			// A cleared composer (fresh session or a sent message) retires the report.
			if (entry === null || draft === '') return null;

			if (typeof entry.error === 'string' && entry.error !== '') {
				return h(
					'div',
					{ className: 'dpeDock', role: 'alert' },
					h(
						'div',
						{ className: 'dpeDockRow' },
						h('span', { className: 'dpeDockText dpeDockFailed', title: entry.error }, t('dock.failed', { message: entry.error })),
						dismissButton(t, sessionId),
					),
				);
			}

			const gaps = entry.gaps;
			const undo = typeof entry.original === 'string' && entry.original !== '' && entry.original !== draft && typeof inputActions === 'object' && inputActions !== null
				? h(
					'button',
					{
						type: 'button',
						className: 'dpeDockAction',
						title: t('dock.undo'),
						onClick: () => {
							inputActions.setDraft(entry.original);
							clearDiagnosis(sessionId);
						},
					},
					t('dock.undo'),
				)
				: null;
			const summaryChildren = [t('dock.done')];
			if (entry.added !== '') summaryChildren.push(' · ' + t('dock.added', { summary: entry.added }));
			if (gaps.length > 0) summaryChildren.push(' · ' + t('dock.gaps', { count: gaps.length }));
			const gapLine = gaps.length === 0
				? null
				: (() => {
					const full = gaps.join(' · ');
					const shown = gaps.slice(0, 5).map((gap) => '- ' + gap).join('  ');
					return h('div', { className: 'dpeDockGaps', title: full }, shown.length > 200 ? shown.slice(0, 200) + '…' : shown);
				})();

			return h(
				'div',
				{ className: 'dpeDock', role: 'status' },
				h('div', { className: 'dpeDockRow' }, h('span', { className: 'dpeDockText' }, ...summaryChildren), undo, dismissButton(t, sessionId)),
				gapLine,
			);
		}

		// ── plugin ─────────────────────────────────────────────────────────────
		/**
		 * Client plugin body: dictionaries, lazy Remote resolution, three slots.
		 * @param {object} ctx - client cordis context (slots + locale declared).
		 */
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh: zh, en: en }), 'prompt-enhancer: dict');

			// The Remote assembly may arrive after this plugin, and a composition
			// without it must still mount the UI: resolve the command verb through
			// a declared inject child and keep the face nullable.
			let executeCommand;
			ctx.effect(
				() => ctx.inject(['remote', 'remote.commands'], (scope) => {
					try {
						const commands = scope.remote === undefined ? undefined : scope.remote.commands;
						executeCommand = commands !== undefined && typeof commands.execute === 'function'
							? commands.execute.bind(commands)
							: undefined;
					} catch (_error) {
						executeCommand = undefined;
					}
					return () => {
						executeCommand = undefined;
					};
				}),
				'prompt-enhancer: commands remote',
			);

			// 1) ✨ control before the submit action.
			ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
				name: 'conversation.input.right',
				id: 'prompt-enhancer',
				order: 50,
				locale: NS,
				inject: (sessionId) => ({
					enhance: async (draft) => {
						if (executeCommand === undefined) {
							return { ok: false, error: { code: 'client/remote-unavailable', message: 'remote.commands unavailable' } };
						}
						return await executeCommand(sessionId, '/' + COMMAND + ' ' + draft, []);
					},
				}),
			}, EnhanceButton));

			// 2) Diagnosis strip under the composer card.
			ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
				name: 'conversation.composer.dock',
				id: 'prompt-enhancer-diagnosis',
				order: 10,
				locale: NS,
			}, DiagnosisStrip));

			// 3) The button-only command keeps no transcript card; typed
			//    /enhance-quiet still resolves through the generic card.
			ctx.slots.inject('conversation.chat.commandview', () => ctx.slots.register({
				name: 'conversation.chat.commandview',
				key: COMMAND,
			}, () => null));
		}

		return {
			name: 'prompt-enhancer',
			inject: ['slots', 'locale'],
			apply: apply,
		};
	},
});
