# Cross-chat continuation and state ownership

Read this reference when resuming a project or updating its current state.

## Resume in one order

1. Resolve the exact project root without borrowing facts from sibling projects.
2. Read `CURRENT_HANDOFF.md` first for stable identity, revision, decisions,
   protected artifacts, risks, and current evidence state.
3. Read `BATTLE_LOG.md` next only when it names an active unstable subsystem. It
   may override that subsystem's conclusion, never project identity or scope.
4. Verify named paths and identifying metadata. Record drift and reconcile the
   owning fact source instead of trusting a filename or recollection.

Use dated summaries only for rationale or conflict resolution. Compare the new
request with recovered scope and resolve conflicts with frozen decisions before
broad edits.

## Apply the right authority chain

```text
Current intent and authorization:
current explicit user instruction > current project state > older summaries

Artifact facts:
live EDA readback > matching saved source/capture > direct battle evidence
> current handoff > older summaries > recollection
```

User reports can change the objective or authorization. Technical claims still
need the applicable source. A stale or unsafe finding applies immediately; it
becomes durable only when writing project state is authorized.

## Keep the handoff current, not historical

Each project root owns one concise `CURRENT_HANDOFF.md`. Separate confirmed
decisions, verified facts with qualifiers, and assumptions. Keep only current
identity, scope, revision, evidence, risks, authoritative/stale artifacts, and
next actions; move chronology and rejected alternatives to dated summaries.
Aim for roughly 40–80 lines when the project permits.

Use this compact shape:

```markdown
# <project> current handoff
Updated: <timestamp and timezone>
Project root: <absolute path>

## Identity, objective, and scope
## Confirmed decisions
## Verified facts and evidence state
## Assumptions, risks, and blockers
## Authoritative and stale artifacts
## Next actions and resume instruction
```

Name one primary next action with its success check. Up to two independent
parallel actions are acceptable when they cannot change or invalidate the
primary path.

Update after a stable material change: phase transition, significant rollback,
new order candidate, major scope change, or resolved fault. Do not paste chat
transcripts or volatile experiment details.

## Use a battle log only for an active fault

Create `BATTLE_LOG.md` only when one subsystem conclusion is changing across
repeated focused experiments. It contains the subsystem boundary, current
hypothesis/conclusion, direct evidence, and one next experiment with a stop
condition. Ordinary implementation, one-off failure, or completed work stays out.

After the conclusion stabilizes, merge a short evidence-linked result into the
handoff and archive or remove the battle log within authorized scope.

## Keep artifact ownership visible

| State | Typical owner |
| --- | --- |
| Requirements and architecture | versioned requirement/design artifacts |
| Schematic intent | contract, BOM, pin/net and test-point maps |
| PCB intent | PCB contract and placement/routing evidence |
| Manufacturing candidate | versioned manifest and Gerber/drill/assembly package |
| Bring-up | validation reports and raw logs |
| Ongoing project state | current handoff and optional active battle log |

Consult the owning artifact before regeneration. Presence or naming alone does
not prove that an artifact matches the active revision.
