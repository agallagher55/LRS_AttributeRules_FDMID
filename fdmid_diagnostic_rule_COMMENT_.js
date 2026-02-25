// =============================================================================
// DIAGNOSTIC RULE — TEMPORARY TEST ONLY — DELETE WHEN Q2/Q3 ARE RESOLVED
// -----------------------------------------------------------------------------
// Feature Class:  SDEADM.E_AddressRange
// Field:          COMMENT_ (Text 100)
// Type:           Calculation Rule
// Triggering:     Insert
// Execution:      Immediate
// Exclude from    YES — FeatureSetByName($datastore) requires server-side eval
//   client eval:
// =============================================================================
//
// PURPOSE
// ───────
// Write a short diagnostic string into COMMENT_ on every INSERT so that
// Q2 and Q3 can be observed directly in the ArcGIS Pro attribute table
// without needing server log access.
//
// READ THE OUTPUT: after a split, check COMMENT_ on both new records.
//
//   "P:1 S:1 KEEPER_* ..."   → sister WAS visible; normal path ran       (Q2 ✓)
//   "P:1 S:0 FALLBACK ..."   → sister NOT visible; conservative fallback fired
//                               If BOTH records show FALLBACK the FDMIDs will
//                               be duplicates unless sequential execution holds  (Q3 !)
//   "P:0 S:- NEW_EVENT ..."  → no retired parent found; treated as new event
//
// OUTPUT FORMAT (all fit within 100 chars)
// ────────────────────────────────────────
//   P:<retiredParentCount>  S:<sisterCount>  <BRANCH>  pFDMID:<parentFDMID>  OID:<myOID>
//
// BRANCH values:
//   NEW_EVENT    — no retired parent; brand-new record
//   FALLBACK     — retired parent found but sister not yet visible
//   KEEPER_ADDR  — keeper by civic address count
//   NKEEPER_ADDR — non-keeper by civic address count
//   KEEPER_LEN   — keeper by segment length
//   NKEEPER_LEN  — non-keeper by segment length
//   KEEPER_OID   — keeper by OBJECTID tiebreaker
//   NKEEPER_OID  — non-keeper by OBJECTID tiebreaker
//
// =============================================================================

var myOID     = $feature.OBJECTID;
var myLength  = $feature.TOMEASURE - $feature.FROMMEASURE;
var myEventId = $feature.EVENTID;

var eventFC = FeatureSetByName(
    $datastore,
    "SDEADM.E_AddressRange",
    ["OBJECTID", "FDMID", "FROMMEASURE", "TOMEASURE", "TODATE", "EVENTID"],
    true    // includeGeometry — needed for sister buffer comparison below
);


// ── Detect retired parent ─────────────────────────────────────────────────────
var retiredParents = Filter(eventFC, "EVENTID = @myEventId AND TODATE IS NOT NULL");
var retiredCount   = Count(retiredParents);

if (retiredCount == 0) {
    return "P:0 S:- NEW_EVENT OID:" + myOID;
}

// Find most recently retired parent (highest OBJECTID — handles repeated splits)
var parentFDMID      = null;
var highestParentOID = -1;
for (var p in retiredParents) {
    if (p.OBJECTID > highestParentOID) {
        highestParentOID = p.OBJECTID;
        parentFDMID = p.FDMID;
    }
}


// ── Find sister ───────────────────────────────────────────────────────────────
var sisters     = Filter(eventFC, "EVENTID = @myEventId AND TODATE IS NULL AND OBJECTID <> @myOID");
var sisterCount = Count(sisters);

if (sisterCount == 0) {
    return "P:" + retiredCount + " S:0 FALLBACK pFDMID:" + parentFDMID + " OID:" + myOID;
}

var sister       = First(sisters);
var sisterOID    = sister.OBJECTID;
var sisterLength = sister.TOMEASURE - sister.FROMMEASURE;


// ── Mirror keeper logic from FDMID rule ───────────────────────────────────────
var addrFC = FeatureSetByName(
    $datastore,
    "LND_civic_address",
    ["OBJECTID"],
    true
);

var myAddrCount     = Count(Intersects(addrFC, Buffer(Geometry($feature), 50, "meters")));
var sisterAddrCount = Count(Intersects(addrFC, Buffer(Geometry(sister),   50, "meters")));

var branch = "";
if (myAddrCount > sisterAddrCount) {
    branch = "KEEPER_ADDR";
} else if (sisterAddrCount > myAddrCount) {
    branch = "NKEEPER_ADDR";
} else if (myLength > sisterLength) {
    branch = "KEEPER_LEN";
} else if (sisterLength > myLength) {
    branch = "NKEEPER_LEN";
} else if (myOID <= sisterOID) {
    branch = "KEEPER_OID";
} else {
    branch = "NKEEPER_OID";
}

return "P:" + retiredCount + " S:" + sisterCount + " " + branch + " pFDMID:" + parentFDMID + " OID:" + myOID;
