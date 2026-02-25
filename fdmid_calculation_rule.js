// =============================================================================
// Attribute Rule: FDMID Auto-Generation
// -----------------------------------------------------------------------------
// Feature Class:  SDEADM.E_AddressRange
// Field:          FDMID (Integer)
// Type:           Calculation Rule
// Triggering:     Insert
// Execution:      Immediate
// Exclude from    YES  ← Required. NextSequenceValue() is server-side only.
//   client eval:       Without this flag the client may attempt local
//                      evaluation and fail to resolve the sequence.
// Sequence:       sdeadm.FDMID_LRS
// ArcGIS Pro:     3.3.5 / Enterprise geodatabase
// =============================================================================
//
// INSERT scenarios handled
// ────────────────────────
//
//   (A) Brand-new event
//       No retired parent record with the same EVENTID exists.
//       New records always arrive with FDMID = NULL, so the split vs.
//       brand-new distinction is made by querying for a retired parent,
//       not by inspecting the incoming FDMID value.
//       → Assign NextSequenceValue("sdeadm.FDMID_LRS")
//
//   (B) LRS event split — "keeper" segment
//       When an event is split, the LRS engine retires the original record
//       (sets TODATE) and INSERTs two new active records, both with FDMID = NULL.
//       The INSERT rule fires on both new records.  One should receive the
//       retired parent's FDMID (continuity of identity); the other gets a new
//       value from the sequence.  A retired parent is detected by querying for
//       a record with the same EVENTID and TODATE IS NOT NULL.
//
//       Because EVENTID persists across repeated splits, multiple retired
//       parents may share the same EVENTID.  The most recently retired record
//       (highest OBJECTID) is used.
//
//       Keeper determination (in priority order):
//         1. Primary  – whichever segment's 50 m buffer contains MORE
//                       LND_civic_address point features keeps the FDMID.
//         2. Fallback – if civic-address counts are equal (or both zero),
//                       the longer segment (TOMEASURE − FROMMEASURE) wins.
//         3. Tiebreak – if lengths are also equal, the lower OBJECTID wins.
//                       (Both records evaluate this identically, so the
//                        result is conflict-free regardless of eval order.)
//
//       → Return retired parent's FDMID.
//
//   (C) LRS event split — "non-keeper" segment
//       → Assign NextSequenceValue("sdeadm.FDMID_LRS")
//
// =============================================================================
//
// DIAGNOSTIC NOTES (Console output — Q2/Q3)
// ──────────────────────────────────────────
// Console() calls throughout this rule log key values to assist with
// confirming two outstanding questions:
//
//   Q2 — Is the sister record visible via FeatureSetByName when the first
//        rule fires?  Look for "sisters found: 0" in the log — if this
//        appears, the conservative fallback fired and sequential execution
//        must be confirmed to avoid duplicate FDMIDs.
//
//   Q3 — Are the two INSERT rules guaranteed to fire sequentially?
//        If sisters count is always > 0, sequential (or session-scoped)
//        execution is implied.  If sisters count is sometimes 0, the
//        fallback is being relied upon.
//
// =============================================================================


// ── Current feature attributes ────────────────────────────────────────────────
var myOID      = $feature.OBJECTID;
var myLength   = $feature.TOMEASURE - $feature.FROMMEASURE;
var myEventId  = $feature.EVENTID;

Console("FDMID Rule start — OID: " + myOID + ", EVENTID: " + myEventId);

var eventFC = FeatureSetByName(
    $datastore,
    "SDEADM.E_AddressRange",
    ["OBJECTID", "FDMID", "FROMMEASURE", "TOMEASURE", "TODATE", "EVENTID"],
    true    // includeGeometry — required for the buffer/intersect comparison below
);


// ── (A) Brand-new record ──────────────────────────────────────────────────────
// A retired parent with the same EVENTID indicates a split.  If none exists,
// this is a genuinely new event.
var retiredParents = Filter(eventFC, "EVENTID = @myEventId AND TODATE IS NOT NULL");
var retiredCount   = Count(retiredParents);

Console("FDMID Rule [OID " + myOID + "]: retired parents found: " + retiredCount);

if (retiredCount == 0) {
    Console("FDMID Rule [OID " + myOID + "]: branch A — brand-new event, assigning new sequence value");
    return NextSequenceValue("sdeadm.FDMID_LRS");
}


// ── (B / C) Split scenario ────────────────────────────────────────────────────
// EVENTID persists across repeated splits, so multiple retired parents may
// exist.  Iterate to find the most recently retired record (highest OBJECTID).
var parentFDMID    = null;
var highestParentOID = -1;

for (var p in retiredParents) {
    if (p.OBJECTID > highestParentOID) {
        highestParentOID = p.OBJECTID;
        parentFDMID = p.FDMID;
    }
}

Console("FDMID Rule [OID " + myOID + "]: using retired parent OID " + highestParentOID + ", parentFDMID: " + parentFDMID);

// Find the active sister split record: same EVENTID, active (TODATE IS NULL),
// different OBJECTID.
var sisters     = Filter(eventFC, "EVENTID = @myEventId AND TODATE IS NULL AND OBJECTID <> @myOID");
var sisterCount = Count(sisters);

// Q2/Q3 diagnostic — key log line
Console("FDMID Rule [OID " + myOID + "]: sisters found: " + sisterCount + " (Q2/Q3 diagnostic)");

// If the sister record is not yet visible in this edit operation, return the
// parent FDMID conservatively.  When the sister's rule fires it will find
// this record and evaluate itself correctly.
// NOTE: if both records hit this branch (sisterCount = 0 for both), they will
// both return parentFDMID and produce a duplicate — see Q2/Q3 in
// outstanding_questions.md.
if (sisterCount == 0) {
    Console("FDMID Rule [OID " + myOID + "]: sister not visible — returning parentFDMID conservatively");
    return parentFDMID;
}

var sister       = First(sisters);
var sisterOID    = sister.OBJECTID;
var sisterLength = sister.TOMEASURE - sister.FROMMEASURE;

Console("FDMID Rule [OID " + myOID + "]: sister OID: " + sisterOID);


// ── Primary: civic address point density ──────────────────────────────────────
// Civic address points are not coincident with the LRS event line segments,
// so a 50 m buffer is applied before intersecting.  The segment whose buffer
// captures more address points is the keeper.

var BUFFER_M = 50;     // buffer distance in metres

var addrFC = FeatureSetByName(
    $datastore,
    "LND_civic_address",
    ["OBJECTID"],
    true    // includeGeometry — required for Intersects()
);

var myBuffer     = Buffer(Geometry($feature), BUFFER_M, "meters");
var sisterBuffer = Buffer(Geometry(sister),    BUFFER_M, "meters");

var myAddrCount     = Count(Intersects(addrFC, myBuffer));
var sisterAddrCount = Count(Intersects(addrFC, sisterBuffer));

Console("FDMID Rule [OID " + myOID + "]: myAddrCount: " + myAddrCount + ", sisterAddrCount: " + sisterAddrCount);


// ── Decision tree ─────────────────────────────────────────────────────────────

// 1. Primary: civic address density
if (myAddrCount > sisterAddrCount) {
    Console("FDMID Rule [OID " + myOID + "]: keeper by address count — returning parentFDMID " + parentFDMID);
    return parentFDMID;
}
if (sisterAddrCount > myAddrCount) {
    Console("FDMID Rule [OID " + myOID + "]: non-keeper by address count — assigning new sequence value");
    return NextSequenceValue("sdeadm.FDMID_LRS");
}

// 2. Fallback: segment length  (longer segment keeps original FDMID)
if (myLength > sisterLength) {
    Console("FDMID Rule [OID " + myOID + "]: keeper by length — returning parentFDMID " + parentFDMID);
    return parentFDMID;
}
if (sisterLength > myLength) {
    Console("FDMID Rule [OID " + myOID + "]: non-keeper by length — assigning new sequence value");
    return NextSequenceValue("sdeadm.FDMID_LRS");
}

// 3. Tiebreaker: lower OBJECTID keeps original FDMID
//    Both records evaluate this identically → guaranteed consistent outcome.
if (myOID <= sisterOID) {
    Console("FDMID Rule [OID " + myOID + "]: keeper by OID tiebreaker — returning parentFDMID " + parentFDMID);
    return parentFDMID;
}
Console("FDMID Rule [OID " + myOID + "]: non-keeper by OID tiebreaker — assigning new sequence value");
return NextSequenceValue("sdeadm.FDMID_LRS");
