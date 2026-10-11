/**
 * Focused check of the "Sign in with Claude" Host half.
 *
 * Drives the real module through a stub of `ctx.authorization` that follows the
 * documented seam contract in `@deepseek-ai/dsh-authorization/lib/index.js`
 * (one attempt per key, `withdrawn` maps to `cancelled`, `HarnessError.code`
 * preserved) and a flow shaped like pi-ai's Anthropic OAuth login
 * (`auth_url` notice, then a `manual_code` prompt racing a browser callback).
 *
 * Requests are driven through the real HTTP handler with fake
 * IncomingMessage/ServerResponse objects, so admission, the endpoint grammar,
 * and the documented unary envelope are covered too.
 *
 * It never touches the live grant record: the stub commits nothing.
 */
import assert from 'node:assert/strict';
import { apply } from '../host.js';

const KEY = 'llm-pi-ai/anthropic';
const CHANNEL = '/claude-signin';

/** A seam stub faithful to the documented contract. */
function createSeam() {
	const flows = new Map();
	const running = new Map();
	const describe = (key) => {
		const flow = flows.get(key);
		if (flow === undefined) return undefined;
		return { key: flow.key, label: flow.label, methods: flow.methods, inFlight: running.has(key) };
	};
	return {
		registerFlow(flow) {
			flows.set(flow.key, flow);
			return () => flows.delete(flow.key);
		},
		describe,
		list() {
			return [...flows.values()].map((flow) => describe(flow.key));
		},
		cancel(key) {
			running.get(key)?.controller.abort();
		},
		async begin(request) {
			const flow = flows.get(request.key);
			if (flow === undefined) throw Object.assign(new Error('no flow'), { code: 'NO_FLOW' });
			const method = request.method ?? flow.methods[0].id;
			if (!flow.methods.some((candidate) => candidate.id === method)) {
				throw Object.assign(new Error('no method'), { code: 'UNKNOWN_METHOD' });
			}
			if (running.has(request.key)) throw Object.assign(new Error('in flight'), { code: 'ALREADY_IN_FLIGHT' });
			const controller = new AbortController();
			const withdraw = () => controller.abort(request.signal.reason);
			request.signal.addEventListener('abort', withdraw, { once: true });
			running.set(request.key, { controller });
			try {
				const withdrawn = new Promise((resolve) =>
					controller.signal.addEventListener('abort', () => resolve('withdrawn'), { once: true }),
				);
				let committed = false;
				const ran = flow.run({
					method,
					signal: controller.signal,
					commit: async () => {
						committed = true;
					},
					notify: (notice) => request.interaction.notify(notice),
					prompt: (prompt) => request.interaction.prompt(prompt),
				});
				if ((await Promise.race([ran.then(() => 'ran'), withdrawn])) === 'withdrawn') {
					ran.catch(() => {});
					return { status: 'cancelled' };
				}
				if (!committed) throw Object.assign(new Error('not committed'), { code: 'NOT_COMMITTED' });
				return { status: 'authorized' };
			} catch (error) {
				if (controller.signal.aborted) return { status: 'cancelled' };
				throw error;
			} finally {
				request.signal.removeEventListener('abort', withdraw);
				running.delete(request.key);
			}
		},
	};
}

/** pi-ai's Anthropic OAuth login, reduced to the seam-facing shape. */
function anthropicLikeFlow({ complete }) {
	return {
		key: KEY,
		label: 'Anthropic',
		methods: [
			{ id: 'oauth', label: 'Claude Pro/Max' },
			{ id: 'api-key', label: 'Anthropic API key' },
		],
		async run(session) {
			session.notify({ message: 'Complete login in your browser.', url: 'https://claude.ai/oauth/authorize?x=1' });
			const manualAbort = new AbortController();
			const manual = session
				.prompt({
					kind: 'text',
					message: 'Paste the authorization code:',
					placeholder: 'http://localhost:53692/callback',
					signal: manualAbort.signal,
				})
				.catch(() => undefined);
			try {
				const raced = await Promise.race([complete(), manual.then((value) => ({ manual: value }))]);
				if (raced === 'withdrawn') return;
				session.notify({ message: 'Exchanging authorization code for tokens...' });
				await session.commit({ kind: 'grant', payload: { type: 'oauth' } });
			} finally {
				manualAbort.abort();
			}
		},
	};
}

/** One fake IncomingMessage carrying a JSON body. */
function fakeRequest({ method = 'POST', url, body, contentType = 'application/json', headers = {} } = {}) {
	const listeners = new Map();
	const req = {
		method,
		url,
		headers: { ...(contentType === null ? {} : { 'content-type': contentType }), ...headers },
		on(event, fn) {
			listeners.set(event, [...(listeners.get(event) ?? []), fn]);
			return req;
		},
		destroy() {},
	};
	queueMicrotask(() => {
		if (body !== undefined) for (const fn of listeners.get('data') ?? []) fn(Buffer.from(body));
		for (const fn of listeners.get('end') ?? []) fn();
	});
	return req;
}

/** One fake ServerResponse that records the status and body. */
function fakeResponse() {
	let settle;
	const finished = new Promise((resolve) => {
		settle = resolve;
	});
	const res = {
		status: undefined,
		body: '',
		finished,
		writeHead(status) {
			res.status = status;
			return res;
		},
		end(body) {
			if (body !== undefined) res.body += body;
			settle();
		},
	};
	return res;
}

/** Mount the plugin against a stub host and expose the channel as a caller sees it. */
function mount(seam, { admit } = {}) {
	let route;
	const ctx = {
		authorization: seam,
		connection: { admit: admit ?? (() => ({ peer: { id: 'operator' } })) },
		webServer: {
			register(candidate) {
				route = candidate;
				return () => {
					route = undefined;
				};
			},
		},
		effect: (fn) => {
			const dispose = fn();
			return typeof dispose === 'function' ? dispose : () => {};
		},
	};
	apply(ctx);
	assert.ok(route !== undefined, 'apply must register one channel route');
	assert.equal(route.kind, 'prefix');
	assert.equal(route.path, CHANNEL);

	/** One unary call exactly as `ctx.connection.rpc.call` frames it. */
	const call = async (endpoint, payload, options = {}) => {
		const req = fakeRequest({
			method: options.method ?? 'POST',
			url: options.url ?? `${CHANNEL}/${endpoint}`,
			body: options.body ?? JSON.stringify({ type: 'client-request', rpcId: 'r1', method: endpoint, payload }),
			contentType: options.contentType === undefined ? 'application/json' : options.contentType,
			headers: options.headers,
		});
		const res = fakeResponse();
		await route.handler(req, res);
		await res.finished;
		if (res.status !== 200) return { http: res.status, body: res.body };
		return { http: res.status, envelope: JSON.parse(res.body) };
	};

	/** The caller's unwrapped result. */
	const rpc = async (endpoint, payload) => {
		const { http, envelope } = await call(endpoint, payload);
		assert.equal(http, 200);
		assert.equal(envelope.type, 'server-response');
		assert.equal(envelope.rpcId, 'r1');
		return envelope.result;
	};

	return { call, rpc };
}

const checks = [];
const check = (name, fn) => checks.push([name, fn]);

check('list: no flow yet, idle attempt', async () => {
	const { rpc } = mount(createSeam());
	const result = await rpc('list', {});
	assert.equal(result.ok, true);
	assert.equal(result.value.flow, null);
	assert.deepEqual(result.value.attempt, {
		status: 'idle',
		inFlight: false,
		notices: [],
		prompt: null,
		error: null,
		startedAt: null,
	});
});

check('begin: NO_FLOW when pi-ai registered nothing', async () => {
	const result = await mount(createSeam()).rpc('begin', {});
	assert.equal(result.ok, false);
	assert.equal(result.error.code, 'NO_FLOW');
});

check('begin: UNKNOWN_METHOD for a method the flow does not offer', async () => {
	const seam = createSeam();
	seam.registerFlow(anthropicLikeFlow({ complete: () => new Promise(() => {}) }));
	const result = await mount(seam).rpc('begin', { method: 'nope' });
	assert.equal(result.ok, false);
	assert.equal(result.error.code, 'UNKNOWN_METHOD');
});

check('begin: surfaces the authorize URL and the code question', async () => {
	const seam = createSeam();
	seam.registerFlow(anthropicLikeFlow({ complete: () => new Promise(() => {}) }));
	const result = await mount(seam).rpc('begin', {});
	assert.equal(result.ok, true);
	assert.equal(result.value.flow.label, 'Anthropic');
	assert.equal(result.value.flow.inFlight, true);
	assert.equal(result.value.attempt.status, 'running');
	assert.equal(result.value.attempt.notices.length, 1);
	assert.equal(result.value.attempt.notices[0].url, 'https://claude.ai/oauth/authorize?x=1');
	assert.equal(result.value.attempt.prompt.kind, 'text');
	assert.equal(result.value.attempt.prompt.placeholder, 'http://localhost:53692/callback');
});

check('begin: ALREADY_IN_FLIGHT while the seam holds the key', async () => {
	const seam = createSeam();
	seam.registerFlow(anthropicLikeFlow({ complete: () => new Promise(() => {}) }));
	const { rpc } = mount(seam);
	assert.equal((await rpc('begin', {})).ok, true);
	const second = await rpc('begin', {});
	assert.equal(second.ok, false);
	assert.equal(second.error.code, 'ALREADY_IN_FLIGHT');
	assert.equal((await rpc('list', {})).value.flow.inFlight, true);
	await rpc('cancel', {});
});

check('answer: drives the flow to authorized and reports progress', async () => {
	const seam = createSeam();
	seam.registerFlow(anthropicLikeFlow({ complete: () => new Promise(() => {}) }));
	const { rpc } = mount(seam);
	await rpc('begin', {});
	const answered = await rpc('answer', { text: 'the-code' });
	assert.equal(answered.ok, true);
	assert.equal(answered.value.attempt.status, 'authorized');
	assert.equal(answered.value.attempt.inFlight, false);
	assert.equal(answered.value.attempt.prompt, null);
	assert.equal(answered.value.flow.inFlight, false);
	assert.ok(answered.value.attempt.notices.some((notice) => /Exchanging/.test(notice.message)));
});

check('answer: NO_PROMPT when nothing is waiting', async () => {
	const seam = createSeam();
	seam.registerFlow(anthropicLikeFlow({ complete: () => new Promise(() => {}) }));
	const { rpc } = mount(seam);
	assert.equal((await rpc('answer', { text: 'x' })).error.code, 'NO_PROMPT');
	await rpc('begin', {});
	assert.equal((await rpc('cancel', {})).ok, true);
	assert.equal((await rpc('answer', { text: 'x' })).error.code, 'NO_PROMPT');
});

check('cancel: withdraws a running attempt without a failure', async () => {
	const seam = createSeam();
	seam.registerFlow(anthropicLikeFlow({ complete: () => new Promise(() => {}) }));
	const { rpc } = mount(seam);
	await rpc('begin', {});
	const cancelled = await rpc('cancel', {});
	assert.equal(cancelled.ok, true);
	assert.equal(cancelled.value.attempt.status, 'cancelled');
	assert.equal(cancelled.value.attempt.inFlight, false);
	assert.equal(cancelled.value.flow.inFlight, false);
	assert.equal((await rpc('begin', {})).ok, true);
	await rpc('cancel', {});
});

check('browser callback wins the race: the prompt is withdrawn, not failed', async () => {
	const seam = createSeam();
	seam.registerFlow(anthropicLikeFlow({ complete: () => Promise.resolve('callback') }));
	const { rpc } = mount(seam);
	assert.equal((await rpc('begin', {})).ok, true);
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal((await rpc('list', {})).value.attempt.status, 'authorized');
});

check('a real flow failure keeps the seam code', async () => {
	const seam = createSeam();
	seam.registerFlow({
		key: KEY,
		label: 'Anthropic',
		methods: [{ id: 'oauth', label: 'Claude Pro/Max' }],
		run: async () => {
			throw Object.assign(new Error('token exchange failed'), { code: 'HTTP_400' });
		},
	});
	const { rpc } = mount(seam);
	const result = await rpc('begin', {});
	await new Promise((resolve) => setTimeout(resolve, 20));
	const settled = result.value.attempt.status === 'failed' ? result.value : (await rpc('list', {})).value;
	assert.equal(settled.attempt.status, 'failed');
	assert.equal(settled.attempt.error.code, 'HTTP_400');
	assert.equal(settled.attempt.error.message, 'token exchange failed');
});

check('unknown endpoint is refused, not thrown', async () => {
	const result = await mount(createSeam()).rpc('nope', {});
	assert.equal(result.ok, false);
	assert.equal(result.error.code, 'UNKNOWN_ENDPOINT');
});

check('an unadmitted request is refused with the fence status', async () => {
	const { call } = mount(createSeam(), { admit: () => ({ rejection: 401 }) });
	const { http } = await call('list', {});
	assert.equal(http, 401);
});

check('a non-POST method is not an endpoint', async () => {
	const { call } = mount(createSeam());
	const { http } = await call('list', {}, { method: 'GET' });
	assert.equal(http, 404);
});

check('a path with no endpoint is refused', async () => {
	const { call } = mount(createSeam());
	const { http } = await call('list', {}, { url: CHANNEL });
	assert.equal(http, 404);
});

check('a wrong content type is refused', async () => {
	const { call } = mount(createSeam());
	const { http, body } = await call('list', {}, { contentType: 'text/plain' });
	assert.equal(http, 415);
	assert.match(body, /application\/json/);
});

check('a method/endpoint mismatch is reported in the envelope', async () => {
	const { call } = mount(createSeam());
	const { http, envelope } = await call('list', {}, { body: JSON.stringify({ type: 'client-request', rpcId: 'r9', method: 'begin', payload: {} }) });
	assert.equal(http, 200);
	assert.equal(envelope.rpcId, 'r9');
	assert.equal(envelope.result.ok, false);
	assert.equal(envelope.result.error.code, 'gateway/bad-request');
});

check('a malformed body is refused', async () => {
	const { call } = mount(createSeam());
	assert.equal((await call('list', {}, { body: '{not json' })).http, 400);
});

let failed = 0;
for (const [name, fn] of checks) {
	try {
		await fn();
		console.log(`  ok   ${name}`);
	} catch (error) {
		failed += 1;
		console.log(`  FAIL ${name}\n       ${error?.message ?? error}`);
	}
}
console.log(failed === 0 ? `\n${checks.length} checks passed` : `\n${failed}/${checks.length} checks FAILED`);
process.exit(failed === 0 ? 0 : 1);
