# pi-claude-auth

`pi-claude-auth` makes Pi's `anthropic` provider bill against your Claude Pro or Max subscription.

When Pi calls Anthropic with an OAuth token, Anthropic treats it as third-party harness traffic. It routes those requests through a separate "extra usage" bucket and bills them per token, outside your plan window. This extension sends the Claude Code billing header and identity, so Anthropic sees the request as Claude Code traffic and draws it from your plan quota.

Pi's built-in `anthropic` provider owns the OAuth lifecycle (browser login, token refresh, and credential storage in `~/.pi/agent/auth.json`). This extension adds only the pieces pi's provider does not send, so requests bill against your plan: the Claude Code user-agent header and the billing header, plus a retry on Anthropic classifier refusals. It deliberately does **not** register a custom OAuth lifecycle — doing so would overwrite pi's built-in provider and break `/login`. (Pi already prefers the stored OAuth token over any `ANTHROPIC_API_KEY` env var, so the extension never needs to touch credentials.)

## 🌐 **Join the Community**

> [!NOTE]
> **Building with AI doesn’t have to be a solo grind.**  
> Join our Discord community to meet other people exploring the latest models, tools, workflows, and ideas: **https://discord.gg/whhrDtCrSS**
>
> We talk about what’s new, what’s useful, and what’s actually worth paying attention to in AI.  
> *And if you want more than conversation,* members also get access to **heavily discounted AI products and services** — including deals on tools like **ChatGPT Plus** and more for just a few dollars.

## Install

```bash
pi install git:github.com/edxeth/pi-claude-auth
```

## How it works

Three things have to line up before Anthropic bills a request against your plan: the right OAuth token, the Claude Code identity in the system prompt, and the billing header that carries the version. Pi's built-in Anthropic provider handles the token plumbing (login, refresh, storage) and the identity. This extension adds the billing header and keeps the version current.

### Credentials

Run `/login anthropic`. Pi's built-in provider performs the browser OAuth flow and writes the `anthropic` entry to `~/.pi/agent/auth.json`:

```json
{ "anthropic": { "type": "oauth", "access": "…", "refresh": "…", "expires": 1750… } }
```

That file is the single source of truth; the extension never reads or writes it. Pi loads the OAuth entry at startup, and its `getApiKey` already prefers that token over any `ANTHROPIC_API_KEY` in your environment, so no credential handling is needed here. Token refresh is handled by pi's built-in provider (which mints and refreshes at Anthropic's `platform.claude.com/v1/oauth/token` endpoint); the extension does not refresh tokens itself.

### The billing header

Every request gets an `x-anthropic-billing-header` system block that carries the Claude Code version and entrypoint. That header is what routes billing to the subscription plan.

Pi's own system prompt gets relocated into the first user message. Anthropic rejects OAuth requests that carry third-party system prompts alongside the Claude Code identity, so the prompt has to move out of `system[]` to avoid a 400 "out of extra usage" rejection.

The `cch` token uses a simplified scheme. It works because Anthropic does not currently enforce `cch` validation. The day Anthropic starts enforcing it, requests will fail until the extension ships an update.

### Version sync

The billing version has to match current Claude Code, or Anthropic rejects the request. The extension resolves the latest `@anthropic-ai/claude-code` version from the npm registry at startup, caches it under `~/.pi/agent/claude-code-version.json`, and falls back to that cache when the registry is unreachable.

The version suffix is computed per request from the current Claude Code algorithm. It is not pinned to a fixed build hash.

If startup cannot reach npm and has no cache, Pi falls back to a built-in version and shows a red alert. If it falls back to a cached version, it shows a yellow alert. Both dismiss with Enter or Escape. Offline runs stay silent.

### Fable and Mythos refusal handling

Claude Fable 5 and Mythos 5 route some requests through safety classifiers. When a classifier blocks a turn, Anthropic returns the refusal as a finished message with `stop_reason: "refusal"` and an explanation. Pi maps that to `stopReason: "error"` with the explanation in `errorMessage` and leaves it there. The original Pi user sees a red error and a dead turn.

This extension adds a client-side retry. When a finalized Anthropic Fable or Mythos assistant message looks like a classifier refusal, the extension switches the active model to Claude Opus 4.8, resends the last user message, and switches back to the original model once Opus finishes.

This is not Anthropic server-side fallback. Server-side fallback sends one request with a `fallbacks` chain and lets Anthropic pick the model internally, then carries the response back over a single stream. That lives inside the provider and reads protocol fields an extension cannot see. The extension here runs two separate turns and works only with the normalized refusal message Pi already exposes.

#### What counts as a refusal

All five conditions must hold on the finalized assistant message:

- role is `assistant`
- provider is `anthropic`
- model id contains `claude-fable-5` or `claude-mythos-5`
- `stopReason` is `error`
- `errorMessage` matches refusal wording (`refus`, `classifier`, `safety`, `usage policy`, `violative`, or `refusals-and-fallback`)

A network timeout fails the wording gate. A generic proxy block fails the wording gate. A refusal on Opus or Sonnet fails the model gate. The Opus retry reply itself fails the model gate, because its model is `claude-opus-4-8`, so the retry cannot retrigger itself.

#### What happens on a refusal

1. The extension resolves both model display names from the active model or Pi's model registry, falling back to the raw model id.
2. It switches to Claude Opus 4.8. If the switch fails, it shows a red notice and stops there.
3. It resends the last user message as a follow-up. No instruction is added telling Opus to bypass anything. Opus sees the original prompt and the Fable refusal that preceded it.
4. After the Opus turn finishes, the extension switches back to the original model.
5. The retry guard clears, so the same prompt can be retried again if you re-ask it later.

The restore waits for the Opus turn. The first `agent_end` belongs to the Fable refusal and is skipped. This prevents the extension from restoring to Fable before the queued Opus request runs.

#### Limits

The extension recovers only after Pi finishes the refusal. If the stream hangs before Pi emits `message_end`, there is nothing to recover from, because the extension never owns the provider stream.

### `/login anthropic`

`/login anthropic` works exactly the usual Pi way — the extension does not register a custom OAuth lifecycle, so pi's built-in `anthropic` provider stays in charge of the browser login, refresh, and storage. Log in once and pi persists the credential to `~/.pi/agent/auth.json`, which this extension then reads on every start.

## Environment variables

| Variable | Use |
| --- | --- |
| `ANTHROPIC_CLI_VERSION` | Override the Claude Code version. Must be valid semver, or the extension ignores it and uses the resolved version. |
| `CLAUDE_CODE_ENTRYPOINT` | Override the billing entrypoint mirrored in the user-agent suffix. |
| `ANTHROPIC_USER_AGENT` | Override the whole user-agent string. |
| `PI_CLAUDE_AUTH_DEBUG` | Set `1` for opt-in diagnostic logging to `~/.pi/agent/pi-claude-auth-debug.log`. Secrets are redacted before anything is written. |

## Credits

- upstream foundation: [pankajudhas81/pi-claude-auth](https://github.com/pankajudhas81/pi-claude-auth)
- this fork: [edxeth/pi-claude-auth](https://github.com/edxeth/pi-claude-auth)

## License

MIT
