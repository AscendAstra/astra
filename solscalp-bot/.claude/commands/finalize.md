You are running the /finalize workflow for the ASTRA trading bot. This validates the entire codebase before updating CLAUDE.md. Follow these steps exactly:

---

## Step 1: Automated Validation

Run the validation script from the project root:

```
node scripts/validate.js
```

Parse the JSON output. If `status` is `"FAIL"`:
- Report every error from `syntax.errors` and `boot.errors`
- Fix each issue
- Re-run `node scripts/validate.js` until `status` is `"PASS"`

If `status` is `"PASS"`, proceed to Step 2.

---

## Step 2: Import/Export Cascade Analysis

Identify all files modified during this session (from conversation context).

For each modified file:
1. Read the file and list all its `import { ... } from '...'` statements
2. For each named import, open the target file and confirm the export exists
3. Check for these special patterns:
   - **Object exports** like `export const notify = { tradeOpen, tradeClose, ... }` in discord.js — verify property names match what callers use (e.g., `notify.tradeOpen(...)`)
   - **Re-exports** and cross-layer imports (monitor → strategies → utils)
   - **Default exports** vs named exports — make sure callers match
4. If any import references a non-existent export, fix the mismatch

If any fixes were made, re-run `node scripts/validate.js` to confirm nothing broke.

---

## Step 3: Update CLAUDE.md

Now update CLAUDE.md with the session recap. Follow the existing format:
- Update the `SESSION RECAP` section at the top with what was done this session
- Update `Files modified:` list
- Add verification checklist items
- Move previous session recap to `Previous session` subsection
- Update any affected sections (architecture, parameters, known issues, infrastructure history, roadmap)

---

## Step 4: Final Validation

Run validation one last time after CLAUDE.md changes:

```
node scripts/validate.js
```

Confirm `status: "PASS"`. Report the final result to the user.

---

## Summary Format

After all steps complete, report:

```
/finalize complete
- Syntax:  22/22 passed
- Boot:    21/21 passed (index.js skipped)
- Cascade: [N issues found and fixed | clean]
- CLAUDE.md: updated
```
