# Outstanding Questions

Open questions about the FDMID attribute rule and LRS split behaviour.

---

## Q2 — Is the sister record visible to `FeatureSetByName` when the first rule fires?

**Status: Open — diagnostic Console() logging added to rule**

**Context:**
When a split occurs, the INSERT rule fires on both new records independently.
The rule searches for the sister using:
`EVENTID = @myEventId AND TODATE IS NULL AND OBJECTID <> @myOID`

If the sister isn't found, the rule returns the parent's FDMID conservatively.
If both records hit this fallback (sister count = 0 for both), they both return
parentFDMID — a duplicate — with no error raised.

**How to observe:**
After a split, check the ArcGIS Pro attribute rule log / server log for lines like:

```
FDMID Rule [OID 12345]: sisters found: 0 (Q2/Q3 diagnostic)
```

- If `sisters found: 0` appears for **either** record → the conservative fallback
  fired; Q3 (sequential execution) must be confirmed to trust the outcome.
- If `sisters found: 1` for **both** records → sister is always visible; the
  fallback is never relied upon.

**Impact:** High — if both records ever return parentFDMID, the rule silently
produces a duplicate FDMID.

---

## Q3 — Are the two INSERT rules guaranteed to fire sequentially?

**Status: Open — indirectly tested via Q2 diagnostic**

**Context:**
If ArcGIS processes the two INSERTs sequentially (one rule fully completes before
the other starts), the first record's result would be committed and visible by the
time the second record's rule runs — making the conservative fallback safe even
when sister count = 0.

If rules can fire concurrently, both could see sister count = 0 simultaneously
and both return parentFDMID, causing a duplicate.

**How to observe:**
Cross-reference with Q2 log output:
- If `sisters found: 0` appears for one record but the final FDMIDs are still
  correct (one parentFDMID, one new sequence value), sequential execution is
  implied.
- If both records end up with parentFDMID (duplicate), concurrent execution
  is likely.

**Impact:** Medium — only matters if Q2 shows the fallback is being triggered.
