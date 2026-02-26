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
//       No active encompassing parent record with the same EVENTID exists.
//       → Assign NextSequenceValue("sdeadm.FDMID_LRS")
//
//   (B/C) LRS event split — keeper / non-keeper
//
//       TIMING NOTE: The LRS engine inserts both child records BEFORE it
//       retires the original record (sets TODATE).  At the moment the INSERT
//       rule fires, the parent still has TODATE IS NULL — querying for a
//       retired parent finds nothing.  Instead, the parent is identified as
//       the active record with the same EVENTID whose measure range
//       ENCOMPASSES the current record's range:
//
//           parent.FROMMEASURE <= myFROM  AND  parent.TOMEASURE >= myTO
//
//       If no such record exists, this is a brand-new event (branch A).
//
//       Because EVENTID persists across repeated splits, the encompassing
//       parent is the one with the highest OBJECTID (most recently created).
//
//       The sister — the other child record created by the same split — is
//       identified precisely to avoid false matches from earlier splits that
//       share the same EVENTID.  A true sister covers the complementary half
//       of the parent's range:
//
//           (sister.FROM = myTO  AND  sister.TO = parentTO)   ← current is left piece
//         OR
//           (sister.FROM = parentFROM  AND  sister.TO = myFROM) ← current is right piece
//
//       Keeper determination (applied in order):
//
//         Step 1 — Sister not yet visible (sisterCount = 0):
//                  This record fires first.  The sister's geometry is not yet
//                  committed, so it is inferred as Difference(parentGeom,
//                  Geometry($feature)) — the portion of the parent polyline
//                  not covered by the current record.  Each civic address point
//                  is then assigned to whichever segment geometry it is closest
//                  to (Distance-based, zero overlap).  The same merit-based
//                  decision tree (address density → length → first-to-fire) is
//                  applied so the outcome is driven by data, not by timing.
//
//         Step 2 — Sister visible and FDMID already assigned:
//                  a. sister.FDMID == parentFDMID → sister is keeper;
//                     this record is non-keeper → NextSequenceValue.
//                  b. sister.FDMID != parentFDMID → sister is non-keeper;
//                     this record is keeper → return parentFDMID.
//
//         Step 3 — Sister visible but FDMID not yet assigned (concurrent):
//                  Each civic address point is assigned to whichever segment
//                  geometry it is closest to (Distance-based, zero overlap),
//                  then the same deterministic decision tree is applied
//                  (address density → length → OID).
//
// =============================================================================


// ── Current feature attributes ────────────────────────────────────────────────
var myOID         = $feature.OBJECTID;
var myFromMeasure = $feature.FROMMEASURE;
var myToMeasure   = $feature.TOMEASURE;
var myLength      = myToMeasure - myFromMeasure;
var myEventId     = $feature.EVENTID;

Console("FDMID Rule start — OID: " + myOID + ", EVENTID: " + myEventId);

var eventFC = FeatureSetByName(
    $datastore,
    "SDEADM.E_AddressRange",
    ["OBJECTID", "FDMID", "FROMMEASURE", "TOMEASURE", "TODATE", "EVENTID"],
    true    // includeGeometry — required for Distance-based address assignment in Steps 1 and 3
);


// ── (A) Brand-new record vs. split child ─────────────────────────────────────
// The LRS engine inserts children before retiring the parent, so we cannot
// detect a split by looking for a retired parent (TODATE IS NOT NULL).
// Instead, look for the not-yet-retired parent: an active record with the
// same EVENTID whose measure range encompasses this record's range.
var activeParents = Filter(
    eventFC,
    "EVENTID = @myEventId AND TODATE IS NULL AND OBJECTID <> @myOID " +
    "AND FROMMEASURE <= @myFromMeasure AND TOMEASURE >= @myToMeasure"
);
var parentCount = Count(activeParents);

Console("FDMID Rule [OID " + myOID + "]: active encompassing parents found: " + parentCount);

if (parentCount == 0) {
    Console("FDMID Rule [OID " + myOID + "]: branch A — brand-new event, assigning new sequence value");
    return NextSequenceValue("sdeadm.FDMID_LRS");
}


// ── (B / C) Split scenario ────────────────────────────────────────────────────
// EVENTID persists across repeated splits, so there could theoretically be
// more than one encompassing active record in unusual data states.  Use the
// highest OBJECTID as the most recently created parent.
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

Console("FDMID Rule [OID " + myOID + "]: using active parent OID " + highestParentOID + ", parentFDMID: " + parentFDMID);

// Identify the sister precisely: she covers the complementary half of the
// parent's range.  This avoids false matches from earlier-split active records
// that happen to share the same EVENTID.
//
//   Current record is left piece  → sister range is [myToMeasure,  parentToM ]
//   Current record is right piece → sister range is [parentFromM,  myFromMeasure]
var sisters = Filter(
    eventFC,
    "EVENTID = @myEventId AND TODATE IS NULL AND OBJECTID <> @myOID AND " +
    "((FROMMEASURE = @myToMeasure AND TOMEASURE = @parentToM) OR " +
    "(FROMMEASURE = @parentFromM AND TOMEASURE = @myFromMeasure))"
);
var sisterCount = Count(sisters);

Console("FDMID Rule [OID " + myOID + "]: sisters found: " + sisterCount);


// ── Step 1: Sister not yet visible ────────────────────────────────────────────
// This record fires first; the sister has not yet been committed, so its
// geometry is unavailable.  Infer the sister's geometry as the portion of the
// parent polyline not covered by the current record:
//   sisterGeom1 = Difference(parentGeom, Geometry($feature))
// Each civic address point is then assigned to whichever segment it is closest
// to (Distance-based, no overlap), and the same merit-based decision tree is
// applied (civic density → segment length → first-to-fire).  The outcome is
// driven by data, not by the arbitrary order in which the two INSERT rules fire.
if (sisterCount == 0) {
    var addrFC1Raw = FeatureSetByName($datastore, "LND_civic_address", ["FDMID"], true);
    var addrFC1    = Filter(addrFC1Raw, "FDMID = @parentFDMID");

    var myGeom1     = Geometry($feature);
    var sisterGeom1 = null;
    if (!IsEmpty(parentGeom)) {
        sisterGeom1 = Difference(parentGeom, myGeom1);
    }
    var myCount1     = 0;
    var sisterApproxCount1 = 0;

    for (var a1 in addrFC1) {
        var pt1 = Geometry(a1);
        if (IsEmpty(pt1) || IsEmpty(sisterGeom1)) { continue; }
        var dMe1  = Distance(pt1, myGeom1);
        var dSis1 = Distance(pt1, sisterGeom1);
        if      (dMe1 < dSis1) { myCount1++; }
        else if (dSis1 < dMe1) { sisterApproxCount1++; }
    }

    Console("FDMID Rule [OID " + myOID + "]: step1 — myCount: " + myCount1 + ", sisterApproxCount: " + sisterApproxCount1);

    // 1. Primary: civic address density
    if (myCount1 > sisterApproxCount1) {
        Console("FDMID Rule [OID " + myOID + "]: step1 keeper by address count — returning parentFDMID " + parentFDMID);
        return parentFDMID;
    }
    if (sisterApproxCount1 > myCount1) {
        Console("FDMID Rule [OID " + myOID + "]: step1 non-keeper by address count — assigning new sequence value");
        return NextSequenceValue("sdeadm.FDMID_LRS");
    }

    // 2. Fallback: longer segment keeps original FDMID
    var sisterLenApprox1 = (parentToM - parentFromM) - myLength;
    if (myLength > sisterLenApprox1) {
        Console("FDMID Rule [OID " + myOID + "]: step1 keeper by length — returning parentFDMID " + parentFDMID);
        return parentFDMID;
    }
    if (sisterLenApprox1 > myLength) {
        Console("FDMID Rule [OID " + myOID + "]: step1 non-keeper by length — assigning new sequence value");
        return NextSequenceValue("sdeadm.FDMID_LRS");
    }

    // 3. Tiebreaker: first to fire claims parentFDMID
    //    (the sister's OID is unknown at this point; as the earlier insert its
    //    OID is expected to be lower, consistent with the lower-OID-wins rule
    //    used in Step 3)
    Console("FDMID Rule [OID " + myOID + "]: step1 keeper by first-to-fire — returning parentFDMID " + parentFDMID);
    return parentFDMID;
}

var sister       = First(sisters);
var sisterOID    = sister.OBJECTID;
var sisterFDMID  = sister.FDMID;
var sisterLength = sister.TOMEASURE - sister.FROMMEASURE;

Console("FDMID Rule [OID " + myOID + "]: sister OID: " + sisterOID + ", sister FDMID: " + sisterFDMID);


// ── Step 2: Sister already has FDMID assigned ─────────────────────────────────
if (!IsEmpty(sisterFDMID)) {
    if (sisterFDMID == parentFDMID) {
        // Sister claimed the parent FDMID → this record is the non-keeper.
        Console("FDMID Rule [OID " + myOID + "]: sister holds parentFDMID — assigning new sequence value");
        return NextSequenceValue("sdeadm.FDMID_LRS");
    }
    // Sister holds a new sequence value → sister is the non-keeper; this is the keeper.
    Console("FDMID Rule [OID " + myOID + "]: sister holds new FDMID — returning parentFDMID " + parentFDMID);
    return parentFDMID;
}


// ── Step 3: Sister visible but FDMID not yet set (concurrent execution) ───────
// Both rules fired before either received its FDMID.  Each civic address point
// is assigned to whichever segment geometry it is closest to (Distance-based,
// no overlap at the split boundary).  A deterministic decision tree is applied
// so both executions reach the same conclusion regardless of eval order.

var addrFCRaw = FeatureSetByName(
    $datastore,
    "LND_civic_address",
    ["FDMID"],
    true
);
var addrFC = Filter(addrFCRaw, "FDMID = @parentFDMID");

var myGeom3      = Geometry($feature);
var sisterGeom3  = Geometry(sister);
var myAddrCount     = 0;
var sisterAddrCount = 0;

for (var a3 in addrFC) {
    var pt3  = Geometry(a3);
    if (IsEmpty(pt3)) { continue; }
    var dMe3  = Distance(pt3, myGeom3);
    var dSis3 = Distance(pt3, sisterGeom3);
    if      (dMe3 < dSis3) { myAddrCount++; }
    else if (dSis3 < dMe3) { sisterAddrCount++; }
}

Console("FDMID Rule [OID " + myOID + "]: concurrent fallback — myAddrCount: " + myAddrCount + ", sisterAddrCount: " + sisterAddrCount);

// 1. Primary: civic address density
if (myAddrCount > sisterAddrCount) {
    Console("FDMID Rule [OID " + myOID + "]: keeper by address count — returning parentFDMID " + parentFDMID);
    return parentFDMID;
}
if (sisterAddrCount > myAddrCount) {
    Console("FDMID Rule [OID " + myOID + "]: non-keeper by address count — assigning new sequence value");
    return NextSequenceValue("sdeadm.FDMID_LRS");
}

// 2. Fallback: longer segment keeps original FDMID
if (myLength > sisterLength) {
    Console("FDMID Rule [OID " + myOID + "]: keeper by length — returning parentFDMID " + parentFDMID);
    return parentFDMID;
}
if (sisterLength > myLength) {
    Console("FDMID Rule [OID " + myOID + "]: non-keeper by length — assigning new sequence value");
    return NextSequenceValue("sdeadm.FDMID_LRS");
}

// 3. Tiebreaker: lower OBJECTID keeps original FDMID
//    Both records evaluate this identically → conflict-free regardless of order.
if (myOID <= sisterOID) {
    Console("FDMID Rule [OID " + myOID + "]: keeper by OID tiebreaker — returning parentFDMID " + parentFDMID);
    return parentFDMID;
}
Console("FDMID Rule [OID " + myOID + "]: non-keeper by OID tiebreaker — assigning new sequence value");
return NextSequenceValue("sdeadm.FDMID_LRS");
