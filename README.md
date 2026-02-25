# LRS Attribute Rule — FDMID Auto-Generation

Arcade calculation rule that assigns a unique **FDMID** to every active record in `SDEADM.E_AddressRange` on INSERT, covering both user-created events and LRS split operations.

---

## Repository Contents

| File | Purpose |
|---|---|
| `fdmid_calculation_rule.js` | Arcade expression — apply this as the attribute rule |
| `FDMID_Rule_Tester_Guide.md` | Step-by-step test scenarios and feedback form for testers |
| `README.md` | This file |

---

## Rule Configuration

Apply the rule in **ArcGIS Pro → Layer Properties → Attribute Rules**, or via `arcpy.management.AddAttributeRule()`, using the following settings:

| Parameter | Value |
|---|---|
| Rule type | Calculation |
| Name | `AutoGenerateFDMID` |
| Script expression | contents of `fdmid_calculation_rule.js` |
| Field | `FDMID` |
| Triggering event | Insert |
| Execution mode | Immediate |
| Exclude from client evaluation | **Yes** ← required |
| Description | Assigns next FDMID from sequence on insert; preserves original FDMID on the keeper segment after an LRS split |

> **Why "Exclude from client evaluation"?**
> `NextSequenceValue()` is an enterprise-only Arcade function that must run server-side. Without this flag the ArcGIS client may attempt local evaluation and fail.

---

## Field Mapping

| Arcade reference | Actual field / object |
|---|---|
| `$feature.FDMID` | `FDMID` — the target field |
| `$feature.EVENTID` | `EVENTID` — shared by the retired parent and both split children; used to detect a split and link to the parent's FDMID; persists across repeated splits |
| `$feature.FROMMEASURE` | `FROMMEASURE` |
| `$feature.TOMEASURE` | `TOMEASURE` |
| `$feature.TODATE` | `TODATE` — non-null on retired records only; used to find the retired parent and exclude it from the sister search |
| `"sdeadm.FDMID_LRS"` | Database sequence supplying unique integers |
| `"SDEADM.E_AddressRange"` | LRS event feature class |
| `"LND_civic_address"` | Civic address point feature class |

---

## How the Rule Works

The rule handles three INSERT scenarios:

### (A) New event

A user or process creates a new event. No retired parent record with the same `EVENTID` exists. All new records arrive with `FDMID = NULL` regardless of scenario, so the split vs. brand-new distinction is made by querying for a retired parent, not by inspecting the incoming FDMID value.

```
→ Assign NextSequenceValue("sdeadm.FDMID_LRS")
```

### (B) LRS split — keeper segment

When the LRS split tool fires, the original record is **retired** (`TODATE` is set) and two new active records are inserted, both with `FDMID = NULL`. The INSERT rule fires on both new records. The rule detects the split by finding a retired record with the same `EVENTID`, then retrieves that parent's FDMID as the value to preserve. Because `EVENTID` persists across repeated splits, there may be multiple retired ancestors — the rule selects the most recently retired one (highest `OBJECTID`).

**Keeper is determined in priority order:**

| Priority | Criterion | Winner |
|---|---|---|
| 1 — Primary | Count `LND_civic_address` points within a 50 m buffer of each segment | Segment with **more** nearby address points |
| 2 — Fallback | Segment length (`TOMEASURE − FROMMEASURE`) | **Longer** segment |
| 3 — Tiebreak | `OBJECTID` | Segment with **lower** OBJECTID |

```
→ Return retired parent's FDMID
```

### (C) LRS split — non-keeper segment

```
→ Assign NextSequenceValue("sdeadm.FDMID_LRS")
```

### Edge case: sister record not yet visible

If the rule fires for one split record before the other is visible in the current edit operation, it conservatively returns the parent's FDMID. When the sister's rule fires it will find this record and evaluate correctly.

---

## Prerequisites

- ArcGIS Enterprise geodatabase (File GDB is not supported — sequences are enterprise-only)
- ArcGIS Pro 3.3.5 / ArcGIS Enterprise 10.9 or later
- Sequence `sdeadm.FDMID_LRS` must exist in the database before applying the rule
- `FDMID` field must be Integer or Long Integer type
- Editor permissions on `SDEADM.E_AddressRange`

---

## Verifying the Rule After Deployment

**Quick smoke test — new event:**
1. Create a new Address Range event, leave FDMID empty, save.
2. Confirm FDMID is populated with a positive integer.

**Split test:**
1. Note the FDMID of an existing event.
2. Split it using the LRS Event Editor.
3. Confirm the two resulting records have *different* FDMIDs — one retaining the original, one assigned a new value from the sequence.

**Uniqueness check (SQL):**
```sql
SELECT FDMID, COUNT(*) AS occurrences
FROM SDEADM.E_AddressRange
WHERE TODATE IS NULL
  AND FDMID IS NOT NULL
GROUP BY FDMID
HAVING COUNT(*) > 1;
```
Expected result: zero rows.

For full test coverage with recorded pass/fail results, use **`FDMID_Rule_Tester_Guide.md`**.

---

## Known Considerations

- **No ternary operators in Arcade:** Arcade does not support the ternary (`? :`) operator. All conditional expressions must use `if / return` statements.
- **`IsNull()` is not a valid Arcade function:** Use `IsEmpty()` instead — it returns `true` for both `null` and empty values, so a separate null check is never needed.
- **Buffer overlap at split point:** A civic address point near the split location may fall inside both segments' 50 m buffers and be counted for both. This does not affect correctness — the comparison still identifies the denser side.
- **FDMID is always overwritten on INSERT:** There is no way to manually set an FDMID and have it persist. The rule always assigns the sequence value. Operators should not attempt to pre-populate this field.
- **Performance:** The spatial buffer + intersect query against `LND_civic_address` runs on every INSERT. In areas with a very large number of civic address points this may add a brief delay on save. Report any slowness via the tester feedback guide.
