# Outstanding Questions

Open questions about the FDMID attribute rule and LRS split behaviour that need
confirmation before the rule can be considered fully validated.

---

## Q1 — Does the INSERT rule fire on both split records, or only the new one?

**Status: RESOLVED**

Confirmed: the INSERT rule fires on **both** resulting records. The original event
is retired (TODATE set) and two brand-new records are inserted, each with
FDMID = NULL. Both trigger the rule independently.

---

## Q2 — Is the sister record visible to `FeatureSetByName` when the first rule fires?

**Status: Open**

**Context:**
The rule searches for the "sister" split record using `FeatureSetByName` filtered
by `EventId = @myEventId AND TODATE IS NULL AND OBJECTID <> @myOID`. If the
sister isn't found, the rule conservatively returns the parent's FDMID (line
79–81 of the rule file).

**Question:**
When the INSERT rule fires for the first of the two split records, is the second
record already visible via `FeatureSetByName($datastore, ...)`? Specifically:

- Is `FeatureSetByName` scoped to the current **edit session** (sees in-flight,
  unsaved inserts), or does it only see **committed/saved** records?
- If the sister is not yet visible, both records would hit the fallback path and
  both would return the parent's FDMID — resulting in a **duplicate FDMID** with
  no error raised.

**Impact:** High — if the fallback fires for both records, the rule silently
produces a duplicate FDMID.

---

## Q3 — Are the two INSERT rules guaranteed to fire sequentially?

**Status: Open**

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

**Status: RESOLVED**

Confirmed: 50 m is appropriate for the density and placement of `LND_civic_address`
points relative to road segments in this dataset.

---

## Q5 — Can `TODATE` be non-null on a record that is NOT retired?

**Status: RESOLVED**

Confirmed: `TODATE` is non-null **only** on retired records. The filter
`TODATE IS NOT NULL` reliably identifies retired parents, and `TODATE IS NULL`
reliably identifies active records.

---

## Q6 — What is the exact field name for EventId?

**Status: Open**

**Context:**
The rule references `$feature.EventId` and filters on `"EventId = @myEventId"`.
The field name was observed in ArcGIS Pro's attribute table but has not been
confirmed against the actual schema.

**Question:**
What is the exact, case-sensitive field name for the event identifier in
`SDEADM.E_AddressRange`? Common variations include `EventId`, `EVENT_ID`,
`EVENTID`, `GlobalID`. If the name in the rule does not match exactly, the
rule will silently evaluate all records as brand-new events (no parent found)
and assign a new FDMID on every split.

**Impact:** High — a wrong field name breaks split detection entirely with no
error raised.

---

## Q7 — Does EventId persist through repeated splits?

**Status: Open**

**Context:**
The rule assumes that when an event is split, both new records share the same
`EventId` as the retired parent. If a record is subsequently split again, the
question is whether the second-generation children still share the same `EventId`
as the original grandparent.

**Question:**
If EventId persists across all generations of splits (grandparent → parent →
children all share the same EventId), the retired-parent query
`EventId = @myEventId AND TODATE IS NOT NULL` would return **multiple** retired
records. The rule currently uses `First()`, which may not return the most
recently retired parent, and could retrieve the wrong FDMID.

If EventId is **not** inherited across generations (each split produces a fresh
EventId), the query will always return exactly one retired parent, and the
current logic is safe.

**Impact:** Medium — only affects records that have been split more than once.
If multiple retired parents are possible, the rule needs to select the most
recent one (e.g. by largest TODATE or largest OBJECTID).
