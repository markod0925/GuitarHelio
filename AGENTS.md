# AGENTS.md

## Permanent Project Rules
- Whenever the project specifications are changed, update `GDD.md` so it stays consistent with the implemented changes.

## Skills
### Available skills
- build-windows-android: Build GuitarHelio for Windows desktop (`.exe` with electron-builder) and Android (`.apk` debug with Capacitor/Gradle). Use when asked to regenerate artifacts, verify build outputs, or troubleshoot recurring packaging/build errors. (file: /mnt/c/Dati/Marco/GameDev/GuitarHelio/skills/build-windows-android/SKILL.md)

### How to use skills
- Discovery: The list above is the skills available in this project context (name + description + file path). Skill bodies live on disk at the listed paths.
- Trigger rules: If the user names a skill (with `$SkillName` or plain text) OR the task clearly matches a skill description, use that skill for that turn.
- Missing/blocked: If a named skill is not available or the path cannot be read, state it briefly and continue with the best fallback.
- How to use a skill (progressive disclosure):
  1) Open its `SKILL.md` and read only what is needed to execute the request.
  2) Resolve relative paths (for example `scripts/foo.py`) from the skill directory first.
  3) If references/templates/scripts exist, load only the files required for the current task.
  4) Prefer using provided scripts/templates instead of rewriting large blocks manually.
- Coordination and sequencing:
  - If multiple skills apply, use the minimal set that covers the request and state the order.
  - Announce which skill(s) you are using and why in one short line.
- Context hygiene:
  - Keep context small: summarize long sections, load only necessary files.
  - Avoid deep reference-chasing unless blocked.
- Safety and fallback: If a skill cannot be applied cleanly (missing files, unclear instructions), state the issue, choose the next-best approach, and continue.

## Code Exploration Policy
Use `cymbal` CLI for code navigation — prefer it over Read, Grep, Glob, or Bash for code exploration.

- New to a repo?: `cymbal structure`
- To understand a symbol: `cymbal investigate <symbol>`
- To understand multiple symbols: `cymbal investigate Foo Bar Baz`
- To trace an execution path: `cymbal trace <symbol>`
- To assess change risk: `cymbal impact <symbol>`
- Before reading a file: `cymbal outline <file>` or `cymbal show <file:L1-L2>`
- Before searching: `cymbal search <query>` or `cymbal search <query> --text`
- Before exploring structure: `cymbal ls` or `cymbal ls --stats`
- To disambiguate: `cymbal show path/to/file:SymbolName` or `cymbal investigate file:Symbol`
- The index auto-builds on first use.
- Prefer `--json` when structured output helps.
