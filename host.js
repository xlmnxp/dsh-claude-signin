/**
 * "Sign in with Claude" — Host half.
 *
 * Surfaces the `llm-pi-ai/anthropic` authorization flow (Claude Pro/Max
 * subscription OAuth) to the Models settings page over one Connection RPC
 * channel, so a subscription sign-in no longer needs the CLI helper.
 *
 * The channel is an ordinary authenticated Connection route: it is admitted by
 * the same Host/Origin fence and browser token every other `/api`-class request
 * passes, so only the page the operator is looking at can reach it. Starting an
 * attempt still only *asks* — the grant is completed by the human in their own
 * browser, and nothing here can authorize on its own. No agent tool is
 * registered, deliberately: granting authority stays user-only.
 *
 * @module dsh-claude-signin
 */

/** pi-ai's credential-record scope, mirrored from `recordKeyFor` in dsh-llm-pi-ai. */
const RECORD_SCOPE = 'llm-pi-ai';
/** The provider route this bundle signs in. */
const PROVIDER = 'anthropic';
/** Method used when the caller names none: the subscription sign-in. */
const DEFAULT_METHOD = 'oauth';
/** The Connection RPC channel this bundle owns. One path segment only. */
const CHANNEL = '/claude-signin';
/**
 * How long a write endpoint waits for the flow's next event before answering
 * anyway. The seam's first notice arrives in milliseconds; this cap only keeps
 * a wedged flow from holding a request open.
 */
const NEXT_EVENT_MS = 4000;

/** Largest request body accepted, in bytes. Endpoint payloads are tiny. */
const MAX_BODY_BYTES = 64 * 1024;
/** Endpoint segment grammar, matching the Client caller's own. */
const ENDPOINT_PATTERN = /^[A-Za-z0-9_$.-]+$/;

export const inject = ['authorization', 'connection', 'webServer'];

/**
 * Register the sign-in channel.
 *
 * The route is claimed directly rather than through
 * `ctx.connection.rpc.handle()`: that helper reads its owning context through
 * the service's own `ctx` shadow, so `owner.webServer` resolves against the
 * connection plugin's fiber — which does not inject `webServer` — and the
 * registration throws. Claiming the route here keeps the ownership, the fence,
 * and the disposer in this plugin, and speaks the same documented unary
 * envelope so the Client half still calls `ctx.connection.rpc.call()`.
 *
 * @param ctx - Host context carrying `authorization`, `connection` and `webServer`.
 */
export function apply(ctx) {
	const attempts = createAttempts(ctx);
	ctx.effect(
		() =>
			ctx.webServer.register({
				kind: 'prefix',
				path: CHANNEL,
				handler: (req, res) => serve(ctx, attempts, req, res),
			}),
		'claude-signin: rpc channel',
	);
}

/** The endpoint one request path names, or `undefined` when it names none. */
function endpointOf(pathname) {
	if (!pathname.startsWith(`${CHANNEL}/`)) return undefined;
	const endpoint = pathname.slice(CHANNEL.length + 1);
	return ENDPOINT_PATTERN.test(endpoint) ? endpoint : undefined;
}

/** Buffer one request body, refusing anything larger than the cap. */
function readBody(req) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		req.on('data', (chunk) => {
			size += chunk.length;
			if (size > MAX_BODY_BYTES) {
				reject(new Error('request body too large'));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
		req.on('error', reject);
	});
}

/** Write one JSON response. */
function send(res, status, body) {
	const text = JSON.stringify(body);
	res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
	res.end(text);
}

/** Refuse a request with a plain-text status. */
function refuse(res, status, message) {
	res.writeHead(status, { 'content-type': 'text/plain' });
	res.end(message);
}

/**
 * Admit, parse, dispatch and answer one call on the sign-in channel.
 * @param ctx - Host context carrying `connection`.
 * @param attempts - this plugin's attempt registry.
 * @param req - the HTTP request.
 * @param res - the HTTP response.
 */
async function serve(ctx, attempts, req, res) {
	// The same Host/Origin fence and browser token every other /api-class
	// request passes: only the page the operator is looking at can reach this.
	const admission = ctx.connection.admit(req);
	if ('rejection' in admission) {
		refuse(res, admission.rejection, admission.rejection === 401 ? 'unauthorized' : 'forbidden');
		return;
	}
	const endpoint = req.method === 'POST' ? endpointOf(new URL(req.url ?? '/', 'http://localhost').pathname) : undefined;
	if (endpoint === undefined) {
		refuse(res, 404, 'not found');
		return;
	}
	const contentType = String(req.headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase();
	if (contentType !== 'application/json') {
		refuse(res, 415, 'content type must be application/json');
		return;
	}
	let envelope;
	try {
		envelope = JSON.parse(await readBody(req));
	} catch {
		refuse(res, 400, 'body is not JSON');
		return;
	}
	if (
		envelope === null ||
		typeof envelope !== 'object' ||
		envelope.type !== 'client-request' ||
		typeof envelope.rpcId !== 'string' ||
		typeof envelope.method !== 'string'
	) {
		refuse(res, 400, 'invalid client-request envelope');
		return;
	}
	if (envelope.method !== endpoint) {
		send(res, 200, {
			type: 'server-response',
			rpcId: envelope.rpcId,
			result: {
				ok: false,
				error: {
					code: 'gateway/bad-request',
					message: `method ${JSON.stringify(envelope.method)} does not match endpoint ${JSON.stringify(endpoint)}`,
					details: {},
				},
			},
		});
		return;
	}
	let result;
	try {
		result = await attempts.dispatch(endpoint, envelope.payload);
	} catch (error) {
		refuse(res, 500, `handler failure: ${String(error)}`);
		return;
	}
	send(res, 200, { type: 'server-response', rpcId: envelope.rpcId, result });
}

/**
 * The one attempt this bundle owns, plus the endpoints a page drives it with.
 *
 * One attempt at a time is the seam's own rule (`ALREADY_IN_FLIGHT`), and it is
 * also what the human sees: two surfaces prompting the same person through the
 * same flow would answer each other's questions. The state therefore lives here
 * rather than in the request, so a reloaded page re-reads the attempt that is
 * already running instead of starting a second one.
 *
 * A request signal is deliberately NOT wired to the attempt: a page that
 * navigates away must not cancel a sign-in the human is still completing in
 * their browser. `cancel` is the only withdrawal.
 *
 * @param ctx - Host context carrying `ctx.authorization`.
 * @returns the endpoint dispatcher.
 */
function createAttempts(ctx) {
	const key = `${RECORD_SCOPE}/${PROVIDER}`;
	/** The latest attempt; kept after settlement so the page can render its outcome. */
	let current = null;
	/** Resolvers waiting for the next interaction point (notice, prompt, settlement). */
	const waiters = new Set();

	/** The live flow entry, or `undefined` when pi-ai has not registered it. */
	const entry = () => ctx.authorization.describe(key);

	const flowView = () => {
		const live = entry();
		if (live === undefined) return null;
		return {
			key: String(live.key),
			label: live.label,
			methods: live.methods.map((method) => ({ id: method.id, label: method.label })),
			// The seam's own fact, so the button disables up front even for an
			// attempt another surface started.
			inFlight: live.inFlight === true,
		};
	};

	const promptView = (prompt) => ({
		kind: prompt.kind,
		message: prompt.message,
		...(prompt.placeholder === undefined ? {} : { placeholder: prompt.placeholder }),
		...(prompt.options === undefined ? {} : { options: prompt.options }),
	});

	const attemptView = () => {
		if (current === null) {
			return { status: 'idle', inFlight: false, notices: [], prompt: null, error: null, startedAt: null };
		}
		return {
			status: current.status,
			inFlight: current.status === 'running',
			notices: current.notices.map((notice) => ({ ...notice })),
			prompt: current.prompt === null ? null : promptView(current.prompt),
			error: current.error === null ? null : { ...current.error },
			startedAt: current.startedAt,
		};
	};

	const view = () => ({ provider: PROVIDER, flow: flowView(), attempt: attemptView() });

	const ok = (value) => ({ ok: true, value });
	const fail = (code, message) => ({ ok: false, error: { code, message, details: {} } });

	/**
	 * Record one visible change and release every waiting endpoint.
	 *
	 * The counter is what makes a wait mean "something new", not "something
	 * exists": an attempt keeps the notices it already emitted, so a caller that
	 * has seen them must not be answered with them again.
	 */
	const bump = (attempt) => {
		attempt.revision += 1;
		for (const waiter of [...waiters]) waiter();
	};

	/**
	 * Resolve once the attempt reaches what the caller is waiting for.
	 *
	 * `activity` — anything new, including a notice: what `begin` waits for, so the
	 * authorize page comes back with the first event instead of a later poll.
	 * `attention` — only what the page must act on, a question or the end: what
	 * `answer` waits for, so it reports the outcome rather than an interim notice.
	 *
	 * @param attempt - the attempt being followed.
	 * @param seen - the revision the caller has already observed.
	 * @param kind - which of the two waits this is.
	 * @param timeoutMs - the cap, so a wedged flow cannot hold a request open.
	 */
	const awaitEvent = (attempt, seen, kind, timeoutMs) => {
		const ready = () =>
			attempt.status !== 'running' ||
			(kind === 'attention' ? attempt.prompt !== null : attempt.revision !== seen);
		if (ready()) return Promise.resolve();
		return new Promise((resolve) => {
			let timer;
			const done = () => {
				clearTimeout(timer);
				waiters.delete(check);
				resolve();
			};
			const check = () => {
				if (ready()) done();
			};
			waiters.add(check);
			timer = setTimeout(done, timeoutMs);
		});
	};

	/** Preserve the seam's machine-routable failure class. */
	const describeFailure = (error) => ({
		code: typeof error?.code === 'string' && error.code.length > 0 ? error.code : 'SIGN_IN_FAILED',
		message: error instanceof Error ? error.message : String(error),
	});

	/**
	 * Put one seam prompt to the page and park the flow until it answers.
	 *
	 * The prompt's own signal is the flow withdrawing its question — pi-ai races
	 * a typed code against a browser callback, and the loser must settle. That is
	 * NOT a decline (only a human's refusal may be), so it rejects with a plain
	 * error and the seam keeps reporting the race's real outcome.
	 */
	const ask = (attempt, prompt) => {
		return new Promise((resolve, reject) => {
			const signal = prompt?.signal;
			const record = {
				kind: typeof prompt?.kind === 'string' ? prompt.kind : 'text',
				message: typeof prompt?.message === 'string' ? prompt.message : '',
				...(typeof prompt?.placeholder === 'string' ? { placeholder: prompt.placeholder } : {}),
				...(Array.isArray(prompt?.options)
					? {
							options: prompt.options.map((option) => ({
								id: String(option.id),
								label: String(option.label),
								...(typeof option.description === 'string' ? { description: option.description } : {}),
							})),
						}
					: {}),
				settle(value) {
					cleanup();
					resolve(value);
				},
				decline() {
					cleanup();
					reject(new Error('the sign-in question was withdrawn'));
				},
			};
			const withdrawn = () => {
				cleanup();
				bump(attempt);
				reject(new Error('the sign-in flow withdrew this question'));
			};
			function cleanup() {
				if (signal !== undefined) signal.removeEventListener('abort', withdrawn);
				if (attempt.prompt === record) attempt.prompt = null;
			}
			if (signal !== undefined && signal.aborted === true) {
				reject(new Error('the sign-in flow withdrew this question'));
				return;
			}
			if (signal !== undefined) signal.addEventListener('abort', withdrawn, { once: true });
			attempt.prompt = record;
			bump(attempt);
		});
	};

	/** Start one attempt and answer as soon as it has something to show. */
	const begin = async (payload) => {
		const method =
			typeof payload?.method === 'string' && payload.method.length > 0 ? payload.method : DEFAULT_METHOD;
		const live = entry();
		if (live === undefined) {
			return fail(
				'NO_FLOW',
				`No authorization flow is registered for "${key}". The llm-pi-ai route for "${PROVIDER}" is not installed in this profile.`,
			);
		}
		if (!live.methods.some((candidate) => candidate.id === method)) {
			return fail('UNKNOWN_METHOD', `The "${key}" flow offers no "${method}" method.`);
		}
		if (live.inFlight === true) {
			return fail('ALREADY_IN_FLIGHT', `An authorization attempt for "${key}" is already running.`);
		}

		const controller = new AbortController();
		const attempt = {
			status: 'running',
			revision: 0,
			notices: [],
			prompt: null,
			error: null,
			startedAt: Date.now(),
			controller,
			settlement: null,
		};
		current = attempt;
		const seen = attempt.revision;

		const interaction = {
			notify(notice) {
				attempt.notices.push({
					message: typeof notice?.message === 'string' ? notice.message : '',
					...(typeof notice?.url === 'string' ? { url: notice.url } : {}),
					...(typeof notice?.code === 'string' ? { code: notice.code } : {}),
					at: Date.now(),
				});
				bump(attempt);
			},
			prompt(prompt) {
				return ask(attempt, prompt);
			},
		};

		attempt.settlement = ctx.authorization
			.begin({ key, method, interaction, signal: controller.signal })
			.then(
				(outcome) => {
					attempt.status = outcome?.status === 'authorized' ? 'authorized' : 'cancelled';
				},
				(error) => {
					// The seam maps a withdrawn or declined attempt to `cancelled`
					// itself, so reaching here is a real failure: keep its code.
					attempt.status = 'failed';
					attempt.error = describeFailure(error);
				},
			)
			.then(() => {
				attempt.prompt = null;
				bump(attempt);
			});

		await awaitEvent(attempt, seen, 'activity', NEXT_EVENT_MS);
		return ok(view());
	};

	/** Hand the human's answer to the waiting prompt. */
	const answer = async (payload) => {
		if (current === null || current.status !== 'running' || current.prompt === null) {
			return fail('NO_PROMPT', 'No sign-in question is waiting for an answer.');
		}
		const text = typeof payload?.text === 'string' ? payload.text : '';
		const prompt = current.prompt;
		// `settle` withdraws the question (one visible change) and lets the flow
		// resume; the baseline is read after it so the wait is for what follows.
		prompt.settle(text);
		const seen = current.revision;
		await awaitEvent(current, seen, 'attention', NEXT_EVENT_MS);
		return ok(view());
	};

	/** Withdraw the running attempt, locally and at the seam. */
	const cancel = async () => {
		if (current !== null && current.status === 'running') {
			const prompt = current.prompt;
			current.prompt = null;
			current.controller.abort();
			if (prompt !== null) prompt.decline();
			ctx.authorization.cancel(key);
			await current.settlement;
		} else {
			// Nothing local: still withdraw an attempt another surface started.
			ctx.authorization.cancel(key);
		}
		return ok(view());
	};

	const dispatch = async (endpoint, payload) => {
		switch (endpoint) {
			case 'list':
				return ok(view());
			case 'begin':
				return begin(payload);
			case 'answer':
				return answer(payload);
			case 'cancel':
				return cancel();
			default:
				return fail('UNKNOWN_ENDPOINT', `Unknown sign-in endpoint "${endpoint}".`);
		}
	};

	return { dispatch };
}
