# Changelog

## [Unreleased]

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
