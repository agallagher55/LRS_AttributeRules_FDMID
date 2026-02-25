# Outstanding Questions

Open questions about the FDMID attribute rule and LRS split behaviour that need
confirmation before the rule can be considered fully validated.

---

## Q1 — Does the INSERT rule fire on both split records, or only the new one?

**Context:**
During an LRS split, the original record is shortened (attributes preserved) and
a new record is inserted with the same attributes. The rule is an INSERT trigger.

**Question:**
Does ArcGIS fire the INSERT attribute rule on **both** resulting records, or only
on the newly inserted record? If only the new record fires:

- The original record always retains its FDMID unchanged (no rule involvement).
- The new record's rule would simply assign a new sequence value every time.
- The keeper/non-keeper comparison logic would be unnecessary.

If both records fire the INSERT rule, the current keeper comparison logic is
correct and necessary.

**Impact:** High — determines whether the comparison logic is needed at all.

---

## Q2 — Is the sister record visible to `FeatureSetByName` when the first rule fires?

**Context:**
The rule searches for the "sister" split record using `FeatureSetByName` filtered
by `FDMID = @myFDMID AND OBJECTID <> @myOID AND TODATE IS NULL`. If the sister
isn't found, the rule conservatively keeps the inherited FDMID (line 79–81 of the
rule file).

**Question:**
When the INSERT rule fires for the first of the two split records, is the second
record already visible via `FeatureSetByName($datastore, ...)`? Specifically:

- Is `FeatureSetByName` scoped to the current **edit session** (sees in-flight,
  unsaved inserts), or does it only see **committed/saved** records?
- If the sister is not yet visible, both records would hit the fallback path and
  both would return the inherited FDMID — resulting in a **duplicate FDMID** with
  no error raised.

**Impact:** High — if the fallback fires for both records, the rule silently
produces a duplicate FDMID, which is exactly the condition it is meant to prevent.

---

## Q3 — Are the two INSERT rules guaranteed to fire sequentially?

**Context:**
Related to Q2. If ArcGIS processes the two INSERTs sequentially (one rule fully
completes before the other begins), the first record's result would be committed
and visible by the time the second record's rule runs.

**Question:**
Does ArcGIS Enterprise guarantee sequential, non-concurrent execution of
Immediate calculation rules triggered within the same edit operation? Or can they
be evaluated in parallel or batched?

**Impact:** Medium — if sequential execution is guaranteed and the first record's
result is visible to the second, Q2 may be moot.

---

## Q4 — Is the 50 m buffer distance appropriate for this dataset?

**Context:**
The keeper determination uses a 50 m buffer around each split segment to count
nearby `LND_civic_address` points. This distance was chosen as a reasonable
default.

**Question:**
Is 50 m an appropriate buffer radius given:
- Typical road widths and address point placement offsets in this dataset?
- The density of civic address points in areas where splits commonly occur?
- Whether address points can be > 50 m from their associated road segment in
  rural or industrial areas?

**Impact:** Low-to-medium — an inappropriate buffer may cause the wrong segment
to be selected as keeper in edge cases, but the fallback (segment length) will
still resolve ties.

---

## Q5 — Can `TODATE` be non-null on a record that is NOT retired?

**Context:**
The sister search filters with `TODATE IS NULL` to find active records. The
original assumption was that `TODATE` is set during an LRS split (retirement),
but it has been clarified that splits do **not** set `TODATE`.

**Question:**
Are there other processes or workflows that set `TODATE` on a record in
`SDEADM.E_AddressRange` without it being a split? For example:
- Manual edits setting a retirement date
- Other LRS tools (extend, truncate, retire event)

If so, the `TODATE IS NULL` filter is still correct (it excludes those records
from the sister search), but it's worth confirming the intent.

**Impact:** Low — informational; confirms the filter is not inadvertently
excluding valid sisters.
