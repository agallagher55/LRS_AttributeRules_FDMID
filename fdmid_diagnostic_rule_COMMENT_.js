// =============================================================================
// DIAGNOSTIC RULE — TEMPORARY TEST ONLY — DELETE WHEN CONFIRMED WORKING
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
// the parent-detection logic can be verified directly in the attribute table.
//
// READ THE OUTPUT: after a split, check COMMENT_ on both new records.
//
//   "P:0 S:- NEW_EVENT OID:…"
//       → No active encompassing parent found; treated as brand-new event.
//         If you see this after a split, the parent detection is still failing.
//
//   "P:1 S:0 KEEPER_ADDR|NKEEPER_ADDR|KEEPER_LEN|NKEEPER_LEN|KEEPER_FTF …"
//       → Parent found; sister not yet visible; merit-based step 1 decision.
//         KEEPER_ADDR / NKEEPER_ADDR — decided by civic address count.
//         KEEPER_LEN  / NKEEPER_LEN  — decided by segment length.
//         KEEPER_FTF                 — decided by first-to-fire (tie on all criteria).
//
//   "P:1 S:1 SIS_HAS_PARENT pFDMID:… OID:…"
//       → Sister is visible and already holds parentFDMID; this record is non-keeper.
//
//   "P:1 S:1 SIS_HAS_NEW pFDMID:… OID:…"
//       → Sister holds a new sequence value; this record is keeper.
//
//   "P:1 S:1 KEEPER_ADDR|NKEEPER_ADDR|KEEPER_LEN|NKEEPER_LEN|KEEPER_OID|NKEEPER_OID …"
//       → Sister visible but FDMID not yet set; concurrent decision tree used.
//
// OUTPUT FORMAT (fits within 100 chars)
// ──────────────────────────────────────
//   P:<parentCount>  S:<sisterCount>  <BRANCH>  pFDMID:<parentFDMID>  OID:<myOID>
//
// =============================================================================

var myOID         = $feature.OBJECTID;
var myFromMeasure = $feature.FROMMEASURE;
var myToMeasure   = $feature.TOMEASURE;
var myLength      = myToMeasure - myFromMeasure;
var myEventId     = $feature.EVENTID;

var eventFC = FeatureSetByName(
    $datastore,
    "SDEADM.E_AddressRange",
    ["OBJECTID", "FDMID", "FROMMEASURE", "TOMEASURE", "TODATE", "EVENTID"],
    true
);


// ── Detect active encompassing parent ────────────────────────────────────────
var activeParents = Filter(
    eventFC,
    "EVENTID = @myEventId AND TODATE IS NULL AND OBJECTID <> @myOID " +
    "AND FROMMEASURE <= @myFromMeasure AND TOMEASURE >= @myToMeasure"
);
var parentCount = Count(activeParents);

if (parentCount == 0) {
    return "P:0 S:- NEW_EVENT OID:" + myOID;
}

var parentFDMID      = null;
var highestParentOID = -1;
var parentFromM      = null;
var parentToM        = null;
var parentGeom       = null;

for (var p in activeParents) {
    if (p.OBJECTID > highestParentOID) {
        highestParentOID = p.OBJECTID;
        parentFDMID      = p.FDMID;
        parentFromM      = p.FROMMEASURE;
        parentToM        = p.TOMEASURE;
        parentGeom       = Geometry(p);
    }
}

var BUFFER_M = 50;

// ── Find sister ───────────────────────────────────────────────────────────────
var sisters = Filter(
    eventFC,
    "EVENTID = @myEventId AND TODATE IS NULL AND OBJECTID <> @myOID AND " +
    "((FROMMEASURE = @myToMeasure AND TOMEASURE = @parentToM) OR " +
    "(FROMMEASURE = @parentFromM AND TOMEASURE = @myFromMeasure))"
);
var sisterCount = Count(sisters);

if (sisterCount == 0) {
    // Mirror step 1 merit-based logic from FDMID rule
    var addrFC1Raw = FeatureSetByName($datastore, "LND_civic_address", ["OBJECTID", "FDMID"], true);
    var addrFC1    = Filter(addrFC1Raw, "FDMID = @parentFDMID");
    var myBuf1     = Buffer(Geometry($feature), BUFFER_M, "meters");
    var myCount1   = Count(Intersects(addrFC1, myBuf1));

    var sisterApproxCount1 = 0;
    if (!IsEmpty(parentGeom)) {
        var parentBuf1       = Buffer(parentGeom, BUFFER_M, "meters");
        var sisterApproxBuf1 = Difference(parentBuf1, myBuf1);
        sisterApproxCount1   = Count(Intersects(addrFC1, sisterApproxBuf1));
    }

    var branch1 = "";
    if (myCount1 > sisterApproxCount1) {
        branch1 = "KEEPER_ADDR";
    } else if (sisterApproxCount1 > myCount1) {
        branch1 = "NKEEPER_ADDR";
    } else {
        var sisterLenApprox1 = (parentToM - parentFromM) - myLength;
        if (myLength > sisterLenApprox1) {
            branch1 = "KEEPER_LEN";
        } else if (sisterLenApprox1 > myLength) {
            branch1 = "NKEEPER_LEN";
        } else {
            branch1 = "KEEPER_FTF";
        }
    }

    return "P:" + parentCount + " S:0 " + branch1 + " m:" + myCount1 + "/s:" + sisterApproxCount1 + " pFDMID:" + parentFDMID + " OID:" + myOID;
}

var sister       = First(sisters);
var sisterOID    = sister.OBJECTID;
var sisterFDMID  = sister.FDMID;
var sisterLength = sister.TOMEASURE - sister.FROMMEASURE;


// ── Mirror Step 2 / Step 3 from FDMID rule ────────────────────────────────────
if (!IsEmpty(sisterFDMID)) {
    if (sisterFDMID == parentFDMID) {
        return "P:" + parentCount + " S:1 SIS_HAS_PARENT pFDMID:" + parentFDMID + " OID:" + myOID;
    }
    return "P:" + parentCount + " S:1 SIS_HAS_NEW pFDMID:" + parentFDMID + " OID:" + myOID;
}

// Concurrent fallback — mirror decision tree
var addrFCRaw = FeatureSetByName(
    $datastore,
    "LND_civic_address",
    ["OBJECTID", "FDMID"],
    true
);
var addrFC = Filter(addrFCRaw, "FDMID = @parentFDMID");

var myAddrCount     = Count(Intersects(addrFC, Buffer(Geometry($feature), BUFFER_M, "meters")));
var sisterAddrCount = Count(Intersects(addrFC, Buffer(Geometry(sister),   BUFFER_M, "meters")));

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

return "P:" + parentCount + " S:1 " + branch + " pFDMID:" + parentFDMID + " OID:" + myOID;
