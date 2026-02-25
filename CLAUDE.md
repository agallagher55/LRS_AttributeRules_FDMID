# Project Reference — LRS FDMID Attribute Rule

Notes and confirmed facts for use when editing this repository.

---

## Feature Class: SDEADM.E_AddressRange

### Confirmed field names (exact, case-sensitive)

| Field | Type | Notes |
|---|---|---|
| `OBJECTID` | Long | Row identifier |
| `EVENTID` | Text (38) | GUID; shared by the retired parent and all split children; persists across repeated splits |
| `FDMID` | Long | Target field for this attribute rule |
| `ROUTEID` | Text (255) | |
| `FROMMEASURE` | Double | |
| `TOMEASURE` | Double | |
| `TODATE` | Date | Non-null only on retired (split/superseded) records; never non-null on an active record |
| `FROMDATE` | Date | |
| `COMMENT_` | Text (100) | Alias: "Street Remarks" |

---

## Arcade Limitations (confirmed)

- **No ternary operator** — `? :` is not supported. Use `if / return` statements.
- **`IsNull()` is not valid** — use `IsEmpty()`, which covers both null and empty.
- **`NextSequenceValue()` is server-side only** — rule must have "Exclude from client evaluation = Yes".

---

## LRS Split Behaviour (confirmed)

- When an event is split, the original record is **retired** (`TODATE` is set to the split date).
- Two new records are **inserted**, both with `FDMID = NULL`.
- The INSERT attribute rule fires on **both** new records independently.
- Both new records share the same `EVENTID` as the retired parent.
- `EVENTID` persists across repeated splits — a record split more than once will have multiple retired ancestors all sharing the same `EVENTID`.
- `TODATE` is non-null **only** on retired records; there is no other workflow that sets it.
