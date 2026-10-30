# Changelog

## [Unreleased]

## [1.4.0] - 2026-10-30

### Breaking Changes

- Requires Pi 1.1.0 or newer. Upgrade Pi before updating this extension.

### Fixed

- Fixed historical Claude thinking blocks being dropped after Edit and retry and after `/reload` on a rewound session. Requests now preserve the retained conversation prefix.
- Fixed Anthropic turns stopping without retry on recognized `connection reset by peer`, `ECONNRESET`, and `unexpected EOF` errors. Pi now retries these failures without a new user message, subject to its existing retry limits and cancellation. See [Transport failures](README.md#transport-failures).

## [1.3.1] - 2026-10-21

### Fixed

#### Mid-reply model switches now offer the refusal menu
Refs: `013c712`

Fixed Fable 5 and Opus 5 turns that ended with `Anthropic performed an unsupported mid-output model fallback` and no way to recover. This happens when Anthropic's safety classifier declines a reply that has already started and a fallback model was requested, for example by a proxy such as CLIProxyAPI in cloak mode. Pi rejects the model switch and ends the turn.

That error now opens the same menu as other classifier refusals, titled, for example, "Claude Opus 5.5's safeguards flagged this response mid-reply.": continue with Claude Opus 4.8, or edit and retry. `PI_CLAUDE_AUTH_REFUSAL_MODE=auto` continues with Opus 4.8 without asking. Other errors that mention a fallback still pass straight through.

## [1.3.0] - 2026-10-09

### New Features

- **Current Claude Code fingerprint (2.1.295)**: Subscription (OAuth) requests now carry the same request fingerprint as real, current Claude Code — prompt/turn stamps in the billing header, matching transport headers, and the machine's device identity in the request body — reducing the risk of rejection or extra-usage billing. See [How it works](README.md#how-it-works).

### Added

#### Full first-party request fingerprint
Refs: `9ab188b`

OAuth requests to api.anthropic.com now include everything real Claude Code 2.1.295 sends:

- `cc_prompt_id`, `cc_turn_origin`, `cc_prompt_index`, and `cc_turn_index` in the billing header, tracked per session (tool-result continuations count as further turns of the same prompt).
- `x-claude-code-prompt-id` (kept identical to the billing header's prompt id) and `x-claude-code-request-class: main` transport headers.
- `metadata.user_id` in the request body, sourced from `~/.claude.json` (`userID`, `oauthAccount.accountUuid`). If that file does not exist, the field is omitted rather than invented.

Previously the billing block carried only cc_version, cc_entrypoint, and cch, which matched no real first-party request. The new fields are covered by the `cch` checksum automatically; the generated block is byte-identical to captured real traffic.

### Changed

- Changed the built-in fallback Claude Code version, used only when npm is unreachable and no cached version exists, from 2.1.198 to 2.1.295 (`9ab188b`).
