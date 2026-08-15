# pi-claude-auth

`pi-claude-auth` makes Pi's `anthropic` provider bill against your Claude Pro or Max subscription.

When Pi calls Anthropic with an OAuth token, Anthropic treats it as third-party harness traffic. It routes those requests through a separate "extra usage" bucket and bills them per token, outside your plan window. This extension sends the Claude Code billing header and identity, so Anthropic sees the request as Claude Code traffic and draws it from your plan quota.

Pi handles the login itself. This extension adds the two headers Pi does not send, and it steps in when Claude refuses a request. It stays out of your credentials: `/login` keeps working the way it always has.

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

## Setup

Run `/login anthropic` and finish the browser flow. That is the whole setup.

Pi stores the credential in `~/.pi/agent/auth.json` and refreshes it when it expires. This extension never touches that file. If you also have `ANTHROPIC_API_KEY` set, Pi still prefers your subscription login.

## How it works

Three things have to line up before Anthropic bills a request to your plan: a valid login, the Claude Code identity in the system prompt, and a header carrying the current Claude Code version. Pi covers the first two. This extension adds the header and keeps the version fresh.

Anthropic rejects requests that carry someone else's system prompt next to the Claude Code identity, so the extension moves Pi's system prompt into your first message. Your instructions still reach the model.

The billing header also carries a `cch` checksum that Claude Code computes over the request body. This extension computes it the same way Claude Code does — a seeded hash of the normalized, serialized body, applied after Pi serializes the request — so the request matches real Claude Code traffic even if Anthropic starts checking the value. It only applies to your subscription (OAuth) login; plain API-key requests pass through unchanged.

### Staying on the current version

Anthropic rejects the header if the version does not match a real Claude Code release, so the extension looks up the newest release on npm at startup and caches it in `~/.pi/agent/claude-code-version.json`.

If npm is unreachable, it falls back to that cache and shows a yellow notification. With no cache to fall back on, it uses a built-in version and shows a red notification, which means requests may be rejected or billed as extra usage. These notifications do not interrupt typing or session startup. Offline runs stay quiet.

## When Claude refuses

Fable 5 and Opus 5 run some requests past a safety classifier. When it blocks one, your turn dies with an error instead of an answer, often after Claude has already done real work.

Instead of leaving you with a dead turn, this extension pauses and offers two ways out.

**Continue with Claude Opus 4.8** switches models and carries on from where things stopped. Finished tool work stays. Opus 4.8 stays selected for the rest of the session, so you keep going without another interruption.

**Edit and retry** rewinds to just before whatever set the classifier off and gives you the prompt box back, still on the original model. Work finished earlier in the turn stays put. If the refusal followed a batch of tool calls, the whole batch goes, since keeping half of it would leave a tool call with no result. Anything you had typed comes back in the editor. The refused path is still there under `/tree` if you want to look at it.

Press Escape to take neither and keep the refusal.

Only Fable 5 and Opus 5 refusals count. Network timeouts, proxy errors, and other models pass straight through, and the Opus 4.8 continuation cannot set the whole thing off again.

Set `PI_CLAUDE_AUTH_REFUSAL_MODE=auto` to skip the question and always continue with Opus 4.8. Outside an interactive terminal (`-p`, JSON output) you get a message saying the turn was refused, and nothing else happens.

### Where Edit and retry stops

On Pi 0.84.2 and newer, Edit and retry refreshes the chat automatically when the session is still at the rewind point. If newer input already moved the branch, that input is kept and the view stays as it is; visit `/tree` to refresh it. Older Pi versions keep the previous behavior, where the view stays stale until you visit `/tree`, run `/reload`, or compact the session.

The rewind covers the conversation. Files written, commands run, and requests sent during the abandoned turn stay exactly as the model left them.

Anything you typed while the refusal was landing still runs after the rewind. Pi gives extensions no way to clear that queue.

The extension steps in once the refusal has fully arrived. A stream that hangs instead never gets that far, and you are back to aborting the turn yourself.

## Environment variables

| Variable | Use |
| --- | --- |
| `ANTHROPIC_CLI_VERSION` | Override the Claude Code version. Must be valid semver, or the extension ignores it and uses the resolved version. |
| `CLAUDE_CODE_ENTRYPOINT` | Override the entrypoint name sent in the billing header and user-agent. |
| `ANTHROPIC_USER_AGENT` | Override the whole user-agent string. |
| `PI_CLAUDE_AUTH_DEBUG` | Set `1` to write diagnostics to `~/.pi/agent/pi-claude-auth-debug.log`. The log redacts secrets. |
| `PI_CLAUDE_AUTH_REFUSAL_MODE` | Refusal policy for Fable 5 and Opus 5: `ask` (default) or `auto`. |
| `ENABLE_PROMPT_CACHING_1H` | Set `1`, `true`, `yes`, or `on` to use Claude Code's one-hour prompt-cache TTL for subscription requests. This overrides short retention. Pi's equivalent process-wide setting is `PI_CACHE_RETENTION=long`. |

## Credits

- upstream foundation: [pankajudhas81/pi-claude-auth](https://github.com/pankajudhas81/pi-claude-auth)
- this fork: [edxeth/pi-claude-auth](https://github.com/edxeth/pi-claude-auth)

## License

MIT
