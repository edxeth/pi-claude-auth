# pi-claude-auth

`pi-claude-auth` makes Pi's `anthropic` provider bill against your Claude Pro or Max subscription.

When Pi calls Anthropic with an OAuth token, Anthropic treats it as third-party harness traffic. It routes those requests through a separate "extra usage" bucket and bills them per token, outside your plan window. This extension sends the Claude Code billing header and identity, so Anthropic sees the request as Claude Code traffic and draws it from your plan quota.

It reads credentials from your Pi auth store, refreshes them through Anthropic's OAuth endpoint, and keeps the Claude Code version in sync with the latest release on npm.

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

Three things have to line up before Anthropic bills a request against your plan: the right OAuth token, the Claude Code identity in the system prompt, and the billing header that carries the version. Pi's built-in Anthropic provider already handles the token plumbing and the identity. This extension adds the billing header and keeps the version current.

### Credentials

The extension reads the `anthropic` OAuth entry from `~/.pi/agent/auth.json`. On every session start it pushes that credential into Pi's live auth storage, so the token takes priority over any `ANTHROPIC_API_KEY` in your environment.

When the access token nears expiry, the extension refreshes it through Anthropic's OAuth token endpoint and writes the rotated token back to `auth.json`. Writes are atomic: a temp file, then a rename, with `0600` permissions. A crash mid-write cannot truncate your only credential store.

### The billing header

Every request gets an `x-anthropic-billing-header` system block that carries the Claude Code version and entrypoint. That header is what routes billing to the subscription plan.

Pi's own system prompt gets relocated into the first user message. Anthropic rejects OAuth requests that carry third-party system prompts alongside the Claude Code identity, so the prompt has to move out of `system[]` to avoid a 400 "out of extra usage" rejection.

The `cch` token uses a simplified scheme. It works because Anthropic does not currently enforce `cch` validation. The day Anthropic starts enforcing it, requests will fail until the extension ships an update.

### Version sync

The billing version has to match current Claude Code, or Anthropic rejects the request. The extension resolves the latest `@anthropic-ai/claude-code` version from the npm registry at startup, caches it under `~/.pi/agent/claude-code-version.json`, and falls back to that cache when the registry is unreachable.

The version suffix is computed per request from the current Claude Code algorithm. It is not pinned to a fixed build hash.

If startup cannot reach npm and has no cache, Pi falls back to a built-in version and shows a red alert. If it falls back to a cached version, it shows a yellow alert. Both dismiss with Enter or Escape. Offline runs stay silent.

### `/login anthropic`

The extension registers the `anthropic` provider with its OAuth lifecycle, so `/login anthropic` works the usual Pi way. The credential you get back is written to `auth.json` and reused on the next start.

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
