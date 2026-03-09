# TEST_FIXER

## Trigger
Fire when:
- `npm test` exits non-zero
- Any test assertion fails in `test/` directory
- Broken imports or missing fixtures in test files
- CI test run fails

## Scope
**In scope:**
- `test/` directory — failing assertions, broken imports, fixture mismatches
- Determining whether root cause is in test code or production code
- Fixing test files or proposing production code fixes

**Out of scope:**
- Production code changes beyond what's needed to fix the failing test (defer to the appropriate domain agent)
- DB schema changes (→ `agents/general/MIGRATION_AGENT.md`)

## Pre-flight
```bash
npm test 2>&1 | tail -50
```
Capture the last 50 lines of test output to identify which tests fail and why.

## Files to read
1. The failing test file(s) identified from the output
2. The production file(s) under test (imports in the test file)

## Execution mode

### Step 1 — Capture failures
Run pre-flight. Extract:
- Test file path(s)
- Test name(s) that failed
- Assertion error or import error

### Step 2 — Classify root cause
| Symptom | Root cause | Fix location |
|---------|-----------|--------------|
| Import error / module not found | Broken import path or missing file | Test file (update import) |
| Assertion mismatch — value changed | Production code changed behavior | Production file (or update test expectation if intentional) |
| Fixture not found | Test fixture missing or renamed | Test file / fixtures dir |
| Type error | API contract changed | Production file |

### Step 3 — Produce PR plan

**If test code is wrong (fixture/import/stale assertion):**
- Fix in test file only
- No production code changes

**If production code is wrong (regression):**
- Identify which production file regressed
- Propose fix in that file
- Note: if change is large, escalate to the relevant domain agent

Output:
- Files to touch
- Diff outline (specific changes)
- Test plan: what should pass after fix

## Output format
```
## Test Fix Plan

**Failing test(s):**
- `test/<file>.mjs` → `<test name>`

**Root cause:** <test code | production regression | broken import | fixture mismatch>

**Fix location:** <test file | production file>

### Diff outline
<specific changes per file>

### Test plan
After fix, run:
```bash
npm test
```
Expected: all assertions pass, exit 0.
```

## Verification
```bash
npm test
# Must exit 0 — all tests pass
```
