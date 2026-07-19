# Agent Workflow — Executing PLAN.md

Two subagents drive the build: **implementer** writes one phase, **reviewer** gates it. You commit only after APPROVED. Repeat for all 4 phases.

## One-time setup

```bash
cd ~/Desktop/programming_projects/task-bot
mkdir -p .claude/agents
mv agents-setup/implementer.md agents-setup/reviewer.md .claude/agents/
git checkout -b multi-user
```

## Per-phase loop (run for Phase 1, then 2, 3, 4)

Start Claude Code in the repo:

```bash
claude
```

**Step 1 — implement.** Prompt:

> Use the implementer agent to execute Phase 1 of PLAN.md.

**Step 2 — review.** Prompt:

> Use the reviewer agent to review Phase 1 against PLAN.md.

**Step 3 — branch on verdict:**

- **CHANGES REQUIRED** → prompt: *"Use the implementer agent to fix the reviewer's issues for Phase 1: <paste the numbered list>"* — then re-run Step 2. Loop until APPROVED.
- **APPROVED** → commit yourself:

```bash
git add -A && git commit -m "<reviewer's suggested message>"
```

**Step 4 — human-only tasks.** The implementer writes AWS CLI commands to `infra/phase-N-setup.sh` but never runs them. Before starting the NEXT phase, review and run that script yourself (Phase 1: tables; Phase 3: SQS + EventBridge; also set new Lambda env vars and re-register the webhook per PLAN.md §7). Phases whose acceptance tests need real AWS resources can only fully pass after this.

**Step 5 — next phase.** Fresh context per phase keeps quality high: exit (`Ctrl+C` twice or `/exit`) and start a new `claude` session, or run `/clear`. Then repeat from Step 1 with the next phase number.

## After Phase 4

1. Run your installed review plugin (your "run after everything" step).
2. Full end-to-end test with two Telegram accounts per PLAN.md §8 — schedules disabled first, then enabled.
3. `git push -u origin multi-user` and open a PR.

## Tips

- Don't skip the fresh-session-per-phase step — a long shared context makes later phases sloppier.
- If the implementer reports an ambiguity in PLAN.md, resolve it by editing PLAN.md (keep it the single source of truth), not by ad-hoc instructions in chat.
- If a review loop goes 3+ rounds on the same issue, the plan wording is probably the problem — fix PLAN.md.
- You stay the only one who commits, pushes, or touches AWS. The agents can't burn anything down.
