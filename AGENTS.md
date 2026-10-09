# AGENTS.md

pi-claude-auth: a pi extension overlaying Pi's built-in Anthropic provider so
OAuth subscription traffic carries the Claude Code client fingerprint and bills
against the Claude Pro/Max plan instead of per-token "extra usage".

## Fingerprint protocol

Verified byte-for-byte against real Claude Code 2.1.295 first-party traffic
(Oct 2026). Single sources live in src; keep this list and the code in sync.

- Billing block `system[0]`:
  `cc_version=<semver>.<3hex>; cc_entrypoint=sdk-cli; cch=<5hex>; cc_prompt_id=<uuid>; cc_turn_origin=sdk; cc_prompt_index=<n>; cc_turn_index=<n>;`
  built in `src/signing.ts`; prompt/turn bookkeeping in `src/turn.ts`
  (new prompt per user message; tool-result continuations advance the turn).
- cc_version suffix: sha256("59cf53e54c78" + chars [4,7,20] of first user
  text + semver), first 3 hex.
- cch: XXH64, seed `0x4d659218e32a3268`, over the serialized body with
  `model=""` and `max_tokens` deleted; low 20 bits as 5 hex. Resolved after
  SDK serialization by the wrapped fetch in `src/cch.ts`.
- Identity `system[1]`: "You are a Claude agent, built on Anthropic's Claude
  Agent SDK." (SDK/non-interactive shape; interactive CC sends the legacy
  line). `src/transforms.ts` swaps pi's legacy identity and relocates all
  other system text into the first user message — mandatory for plan billing.
- Transport headers: `user-agent: claude-cli/<ver> (external, sdk-cli)`,
  `x-app: cli`, `x-claude-code-session-id`, per-request `x-client-request-id`,
  `x-claude-code-prompt-id` (mirrors cc_prompt_id),
  `x-claude-code-request-class: main`.
- Body fingerprint: `metadata.user_id` = JSON string of device_id /
  account_uuid / session_id; device id and account uuid come from
  `~/.claude.json` (`userID`, `oauthAccount.accountUuid`), omitted when the
  file is absent — `src/device-id.ts`.
- Version: resolved from npm `@anthropic-ai/claude-code/latest`, cached in
  `~/.pi/agent/claude-code-version.json`; `FALLBACK_CC_VERSION` in
  `src/signing.ts` must name a real release.

## Verification

- Live smoke (uses subscription quota, cheap on haiku):
  `PI_CLAUDE_AUTH_DEBUG=1 pi -p --model anthropic/claude-haiku-5-5 "Reply with exactly: OK"`
  then check `~/.pi/agent/pi-claude-auth-debug.log` for `device_identity`,
  `billing_header_injected`, and `cch_patched`. Success of the turn plus those
  events is the pass signal; the smoke cannot observe billing routing.
- Fingerprint ground truth is real Claude Code binaries, not community
  write-ups (at least one popular reverse-engineering doc mislabels cch). To
  re-verify after a protocol change: download the current
  `@anthropic-ai/claude-code` platform tarball from npm, run it against a
  local capture server (`ANTHROPIC_BASE_URL` + `CLAUDE_CODE_OAUTH_TOKEN`),
  and replay captured bodies through `src/cch.ts` / `src/signing.ts`;
  `test/cch.test.ts` pins the billing-block shape.

## Accepted divergences and risks

- anthropic-beta flags follow pi's built-in feature-driven list, not Claude
  Code's longer one: claiming betas whose wire effects pi does not implement
  risks unparseable responses.
- Impersonating Claude Code on subscription OAuth is against Anthropic's
  published terms (Jan 2026 server-side gate, acknowledged client-fingerprint
  detection). Ban risk is accepted by the owner; do not widen the spoof's
  coverage without asking.

## Portability

- This package is used and developed on Linux (any distribution) and macOS.
  Every change (runtime code, tests, scripts, tooling, docs) must work the
  same on both, with no per-machine setup.
- Choose mechanisms that behave the same everywhere: Node built-ins,
  documented tool interfaces, and runtime detection of what is available
  (see `src/paths.ts` and the platform-gated chmod in `src/claude-version.ts`)
  instead of assumptions about one machine.
- When the platforms really differ, handle each one on purpose at one
  boundary, and check both paths.
- Ask the user before you choose a solution that works on only one platform,
  behaves differently between them, or adds a system requirement. Present the
  portable alternative and what it costs.

## Traps

- Runtime module resolution: pi's extension loader redirects
  `@earendil-works/*` imports to the running pi's own copies (jiti aliases /
  VIRTUAL_MODULES). This repo's node_modules is types/tests only; a plain
  `bun` / `import.meta.resolve` check suggests otherwise.
- bun's `os.homedir()` ignores a runtime-set `process.env.HOME`; control the
  path by injection instead (see `loadClaudeCodeIdentity(path)`).
