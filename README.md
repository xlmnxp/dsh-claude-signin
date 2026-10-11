# dsh-claude-signin

A **DeepSeek Harness** plugin that puts a **Sign in with Claude** button on the Anthropic
provider card in **Settings → Models**, so a Claude Pro/Max subscription sign-in no longer
needs a CLI script.

The plugin is a thin UI and transport layer. It does **not** implement OAuth itself: it
surfaces the authorization flow that `@deepseek-ai/dsh-llm-pi-ai` already registers for its
`anthropic` route (key `llm-pi-ai/anthropic`) and renders the result in the harness UI.
It stores no credentials of its own — the grant lands in the harness credential store, which
is exactly where the CLI helper would have written it.

---

## What you get

| | |
|---|---|
| **Seat** | `settings.models.provider-card`, keyed on the `llm-pi-ai` settings namespace |
| **Renders for** | the `anthropic` provider row only |
| **Flow** | `llm-pi-ai/anthropic` → `oauth` ("Claude Pro/Max") |
| **Transport** | one Connection RPC channel: `/claude-signin` |
| **Entry points** | `list`, `begin`, `answer`, `cancel` |

## Requirements

- DeepSeek Harness with `@deepseek-ai/dsh-llm-pi-ai` installed (present in the `dsh-base`
  bundle). Without it the flow is not registered and `begin` answers `NO_FLOW`.
- A Claude Pro/Max subscription, if you intend to use the `oauth` method.
- Node.js 20+ only for running the test suite.

## Install

Install it as a DSH **bundle** through the plugin manager, pointing at this directory (a local
`link:` install is what this repo is developed against). The manager adds the package to the
profile's `dsh.profile.bundles` and its `dependencies` — do not hand-edit the profile's
`package.json` or `cordis.patch.yml`.

The bundle's own contribution is [`cordis.patch.yml`](cordis.patch.yml):

```yaml
- insert:
    - id: claude-signin
      name: '@local/claude-signin'
```

Once loaded, open **Settings → Models** and look at the **Anthropic** card.

## How it works

The plugin ships two halves.

### Host half — [`host.js`](host.js)

Injects `authorization`, `connection` and `webServer`, and claims the `/claude-signin` prefix
route on the harness web server. Every request passes the same Host/Origin fence and browser
token as any other `/api`-class call, so only the page the operator is looking at can reach it.
Bodies are capped at 64 KiB and must be `application/json`.

It also owns the **one** attempt the bundle allows at a time. A single in-flight attempt is the
seam's own rule (`ALREADY_IN_FLIGHT`) and it is what the human sees: two surfaces prompting the
same person through the same flow would answer each other's questions. Attempt state therefore
lives in the plugin rather than in the request, so a reloaded page re-reads the attempt that is
already running instead of starting a second one.

A request signal is deliberately **not** wired to the attempt — a page that navigates away must
not cancel a sign-in the human is still completing in their browser. `cancel` is the only
withdrawal.

### Client half — [`client.js`](client.js)

Registers one cell of the keyed `settings.models.provider-card` seat. The cell registers for the
`llm-pi-ai` namespace and renders only for the anthropic row; every other provider card in that
namespace gets `null`. It shows the button, the authorize URL / manual-code prompt, live notices,
and the outcome, and disables itself while an attempt is in flight.

Locale strings live in [`locale/en.json`](locale/en.json) and [`locale/zh.json`](locale/zh.json).

## Endpoints

All four are `POST` on `/claude-signin/<endpoint>` with a `client-request` envelope.

| Endpoint | Purpose |
|---|---|
| `list` | Current flow (methods, `inFlight`) and attempt state |
| `begin` | Start an attempt on a method; answers at the first new event |
| `answer` | Hand the human's text to the waiting prompt |
| `cancel` | Withdraw the running attempt, locally and at the seam |

Write endpoints wait up to 4 s for the flow's next event before answering anyway, so a wedged
flow cannot hold a request open.

## Error codes

Returned in the `ok: false` envelope, preserving the seam's machine-routable class.

| Code | Meaning |
|---|---|
| `NO_FLOW` | No flow registered for `llm-pi-ai/anthropic` (pi-ai route not installed) |
| `UNKNOWN_METHOD` | The flow offers no such method |
| `ALREADY_IN_FLIGHT` | An attempt for this key is already running |
| `NO_PROMPT` | `answer` called with no question waiting |
| `UNKNOWN_ENDPOINT` | Unknown endpoint name |

Plus the envelope-level refusals: `401`/`403` from the admission fence, `404` unknown path,
`415` wrong content type, `400` malformed body or envelope.

## Security

- **Granting authority stays user-only.** No agent tool is registered, deliberately. The button
  asks the host to *start* an attempt; the grant is completed by the human in their own browser,
  and nothing in this plugin can authorize on its own.
- The RPC channel is admitted by the same fence as every other `/api`-class request. It is not
  an unauthenticated endpoint.
- The plugin holds no secrets and writes no credential files. The resulting grant is stored by
  the harness credential store.
- The request-signal decision above is a security-relevant choice, not just ergonomics: a
  navigation away must not abandon a half-completed sign-in.

## Development

```bash
node --test test/
```

The suite covers the attempt lifecycle (begin/answer/cancel, the browser-callback race, seam
failure codes) and the request-level refusals, with no harness running.

## License

[MIT](LICENSE). Not affiliated with or endorsed by Anthropic PBC. "Claude" and "Anthropic" are
trademarks of Anthropic PBC, used here descriptively.
