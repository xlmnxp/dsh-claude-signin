/**
 * "Sign in with Claude" — Client half.
 *
 * One cell of the keyed `settings.models.provider-card` seat, which the Models
 * section dispatches into every provider card with `entryKey = settingsNs`.
 * The cell registers for the pi-ai settings namespace and renders only for the
 * anthropic row; every other provider card of that namespace gets `null`.
 *
 * It talks to the Host half over the `/claude-signin` Connection RPC channel.
 * The button never authorizes anything by itself — it asks the Host to start an
 * attempt and then renders the page the human must open.
 */
window.__ModuleLoader__.load({
	id: '@local/claude-signin',
	factory(require) {
		const React = require('react');
		const h = React.createElement;

		/** The Host half's Connection RPC channel. */
		const CHANNEL = '/claude-signin';
		/** This plugin's Client locale namespace. */
		const NS = 'claude-signin';
		/** The pi-ai settings entry id: the keyed cell every provider card dispatches. */
		const SETTINGS_NS = 'llm-pi-ai';
		/** The provider route this button signs in. */
		const PROVIDER = 'anthropic';
		/** How often a running attempt is re-read while the human is in their browser. */
		const POLL_MS = 1000;

		/**
		 * Copied from `@deepseek-ai/dsh-client-ui-primitives` Button/Input and
		 * renamed under this plugin's prefix: the same control dimensions, the same
		 * neutral stroke, and only `--dsw-*` token references. Rendered as a React
		 * element so unmounting the cell removes it.
		 */
		const STYLE = `
.dsh-claude-signin { display: flex; flex-direction: column; gap: 8px; }
.dsh-claude-signin__hint { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
.dsh-claude-signin__notice { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
.dsh-claude-signin__success { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-state-success-primary); }
.dsh-claude-signin__error { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-state-error-primary); }
.dsh-claude-signin__actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dsh-claude-signin__field { display: flex; align-items: center; gap: 6px; }
.dsh-claude-signin__button { box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center; gap: 4px; height: 28px; padding: 0 10px; border: none; border-radius: var(--dsw-radius-sm); cursor: pointer; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-primary); background: transparent; }
.dsh-claude-signin__button:disabled { cursor: not-allowed; opacity: 0.4; }
.dsh-claude-signin__button--primary { background: var(--dsw-alias-button-primary-fill); color: var(--dsw-alias-label-primary-foreground); }
.dsh-claude-signin__button--primary:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover); }
.dsh-claude-signin__button--outline { border: 0.5px solid var(--dsw-alias-border-l3); }
.dsh-claude-signin__button--outline:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.dsh-claude-signin__link { color: var(--dsw-alias-brand-primary); word-break: break-all; }
.dsh-claude-signin__code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--dsw-alias-label-primary); }
.dsh-claude-signin__input { box-sizing: border-box; flex: 1; min-width: 0; height: 32px; padding: 0 8px; border: 0.5px solid var(--dsw-alias-border-l4); border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font-size: 14px; line-height: 22px; outline: none; }
.dsh-claude-signin__input::placeholder { color: var(--dsw-alias-label-dimmed); }
.dsh-claude-signin__input:focus { border-color: var(--dsw-alias-state-business-primary); }
`;

		/**
		 * The Anthropic provider card's sign-in cell.
		 * @param props - slot props plus the closed-over bridge and translator.
		 */
		function AnthropicSignIn(props) {
			const { rpc, t, locale } = props;
			const [state, setState] = React.useState(null);
			const [transport, setTransport] = React.useState(null);
			const [text, setText] = React.useState('');
			const [pending, setPending] = React.useState(null);

			// Re-render on a locale switch: `t` reads the active locale at call time.
			React.useSyncExternalStore(
				React.useCallback((notify) => (locale === undefined ? () => {} : locale.subscribe(notify)), [locale]),
				() => (locale === undefined ? 0 : locale.getSnapshot().revision),
				() => 0,
			);

			const call = React.useCallback(
				async (endpoint, payload) => {
					if (rpc === undefined) {
						return {
							ok: false,
							error: { code: 'NO_BRIDGE', message: 'The Host connection service is unavailable.' },
						};
					}
					try {
						const result = await rpc.call(CHANNEL, endpoint, payload ?? {});
						if (result === undefined || typeof result !== 'object') {
							return { ok: false, error: { code: 'BAD_RESPONSE', message: 'The Host returned no result.' } };
						}
						return result;
					} catch (cause) {
						return {
							ok: false,
							error: {
								code: 'TRANSPORT',
								message: cause instanceof Error ? cause.message : String(cause),
							},
						};
					}
				},
				[rpc],
			);

			const absorb = React.useCallback((result) => {
				if (result.ok === true) {
					setState(result.value);
					setTransport(null);
					return;
				}
				setTransport(result.error);
			}, []);

			// Read the Host once so a running attempt is honoured up front.
			React.useEffect(() => {
				let cancelled = false;
				void call('list').then((result) => {
					if (!cancelled) absorb(result);
				});
				return () => {
					cancelled = true;
				};
			}, [call, absorb]);

			const attempt = state === null ? null : state.attempt;
			const flow = state === null ? null : state.flow;
			const inFlight = (attempt !== null && attempt.inFlight === true) || (flow !== null && flow.inFlight === true);

			// Follow a running attempt: notices and the question arrive after `begin`.
			React.useEffect(() => {
				if (!inFlight) return undefined;
				const timer = window.setInterval(() => {
					void call('list').then(absorb);
				}, POLL_MS);
				return () => window.clearInterval(timer);
			}, [inFlight, call, absorb]);

			const run = async (endpoint, payload) => {
				setPending(endpoint);
				try {
					absorb(await call(endpoint, payload));
				} finally {
					setPending(null);
				}
			};

			const prompt = attempt === null ? null : attempt.prompt;
			const busy = pending !== null;

			const submit = async () => {
				const fallback = prompt !== null && prompt.kind === 'select' ? (prompt.options?.[0]?.id ?? '') : '';
				const value = text === '' ? fallback : text;
				setText('');
				await run('answer', { text: value });
			};

			const nodes = [];

			if (attempt !== null && attempt.status === 'authorized') {
				nodes.push(h('p', { className: 'dsh-claude-signin__success', key: 'authorized' }, t('authorized')));
			}
			if (attempt !== null && attempt.status === 'cancelled') {
				nodes.push(h('p', { className: 'dsh-claude-signin__notice', key: 'cancelled' }, t('cancelled')));
			}
			if (attempt !== null && attempt.status === 'failed') {
				nodes.push(
					h(
						'p',
						{ className: 'dsh-claude-signin__error', key: 'failed' },
						`${t('failed')} ${attempt.error?.code ?? 'SIGN_IN_FAILED'}: ${attempt.error?.message ?? ''}`,
					),
				);
			}
			if (transport !== null) {
				nodes.push(
					h('p', { className: 'dsh-claude-signin__error', key: 'transport' }, `${transport.code}: ${transport.message}`),
				);
			}

			// Every notice the flow emitted, in order: the authorize page first.
			for (const [index, notice] of (attempt === null ? [] : attempt.notices).entries()) {
				nodes.push(
					h('p', { className: 'dsh-claude-signin__notice', key: `notice-${index}` }, [
						notice.message,
						notice.url === undefined
							? null
							: h(
									'a',
									{
										className: 'dsh-claude-signin__link',
										href: notice.url,
										target: '_blank',
										rel: 'noreferrer noopener',
										key: 'url',
									},
									notice.url,
								),
						notice.code === undefined
							? null
							: h('code', { className: 'dsh-claude-signin__code', key: 'code' }, ` ${notice.code}`),
					]),
				);
			}

			if (prompt !== null) {
				nodes.push(h('p', { className: 'dsh-claude-signin__hint', key: 'question' }, prompt.message));
				if (prompt.kind === 'select') {
					const chosen = text === '' ? (prompt.options?.[0]?.id ?? '') : text;
					nodes.push(
						h('div', { className: 'dsh-claude-signin__field', key: 'answer' }, [
							h(
								'select',
								{
									className: 'dsh-claude-signin__input',
									value: chosen,
									disabled: busy,
									onChange: (event) => setText(event.target.value),
									key: 'input',
								},
								(prompt.options ?? []).map((option) =>
									h('option', { value: option.id, key: option.id }, option.label),
								),
							),
							h(
								'button',
								{
									type: 'button',
									className: 'dsh-claude-signin__button dsh-claude-signin__button--primary',
									disabled: busy,
									onClick: () => void submit(),
									key: 'submit',
								},
								t('continue'),
							),
						]),
					);
				} else {
					nodes.push(
						h('div', { className: 'dsh-claude-signin__field', key: 'answer' }, [
							h('input', {
								className: 'dsh-claude-signin__input',
								type: prompt.kind === 'secret' ? 'password' : 'text',
								value: text,
								placeholder: prompt.placeholder ?? '',
								disabled: busy,
								onChange: (event) => setText(event.target.value),
								onKeyDown: (event) => {
									if (event.key === 'Enter' && text.trim().length > 0) void submit();
								},
								key: 'input',
							}),
							h(
								'button',
								{
									type: 'button',
									className: 'dsh-claude-signin__button dsh-claude-signin__button--primary',
									disabled: busy || text.trim().length === 0,
									onClick: () => void submit(),
									key: 'submit',
								},
								t('continue'),
							),
						]),
					);
				}
			}

			const actions = [
				h(
					'button',
					{
						type: 'button',
						className: 'dsh-claude-signin__button dsh-claude-signin__button--primary',
						disabled: inFlight || busy || state === null,
						onClick: () => void run('begin', {}),
						key: 'begin',
					},
					inFlight ? t('working') : t('signIn'),
				),
			];
			if (inFlight) {
				actions.push(
					h(
						'button',
						{
							type: 'button',
							className: 'dsh-claude-signin__button dsh-claude-signin__button--outline',
							disabled: busy,
							onClick: () => void run('cancel'),
							key: 'cancel',
						},
						t('cancel'),
					),
				);
			}

			return h('div', { className: 'dsh-claude-signin' }, [
				h('style', { key: 'style' }, STYLE),
				h('p', { className: 'dsh-claude-signin__hint', key: 'hint' }, t('hint')),
				h('div', { className: 'dsh-claude-signin__actions', key: 'actions' }, actions),
				...nodes,
			]);
		}

		/** English texts; `zh` below is the same key set. */
		const EN = {
			signIn: 'Sign in with Claude',
			working: 'Signing in…',
			hint: 'Use a Claude Pro/Max subscription instead of an API key.',
			continue: 'Continue',
			cancel: 'Cancel',
			authorized: 'Signed in. This route now uses your Claude subscription.',
			cancelled: 'Sign-in cancelled.',
			failed: 'Sign-in failed.',
		};
		const ZH = {
			signIn: '使用 Claude 登录',
			working: '正在登录…',
			hint: '使用 Claude Pro/Max 订阅，无需 API 密钥。',
			continue: '继续',
			cancel: '取消',
			authorized: '已登录。此路由现在使用你的 Claude 订阅。',
			cancelled: '已取消登录。',
			failed: '登录失败。',
		};

		return {
			inject: ['slots', 'connection'],
			apply(ctx) {
				const connection = ctx.get('connection');
				const rpc = connection === undefined ? undefined : connection.rpc;
				const locale = ctx.get('locale');
				const t = locale === undefined ? (key) => key : locale.bind(NS);

				if (locale !== undefined) {
					ctx.effect(() => locale.register(NS, 'en', EN), 'claude-signin: en dictionary');
					ctx.effect(() => locale.register(NS, 'zh', ZH), 'claude-signin: zh dictionary');
				}

				ctx.slots.inject('settings.models.provider-card', () =>
					ctx.slots.register(
						{
							name: 'settings.models.provider-card',
							// The cell key is the provider row's `settingsNs`, so this one
							// registration is dispatched into every pi-ai provider card.
							key: SETTINGS_NS,
						},
						(props) => {
							if (props?.provider?.provider !== PROVIDER) return null;
							return h(AnthropicSignIn, { ...props, rpc, t, locale });
						},
					),
				);
			},
		};
	},
});
