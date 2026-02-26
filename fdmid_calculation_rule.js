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
//                  This record fires first (sequential execution).
//                  Claim parentFDMID now.  The sister will observe this
//                  assignment in Step 2 when its rule fires.
//
//         Step 2 — Sister visible and FDMID already assigned:
//                  a. sister.FDMID == parentFDMID → sister is keeper;
//                     this record is non-keeper → NextSequenceValue.
//                  b. sister.FDMID != parentFDMID → sister is non-keeper;
//                     this record is keeper → return parentFDMID.
//
//         Step 3 — Sister visible but FDMID not yet assigned (concurrent):
//                  Deterministic decision tree (address density → length → OID).
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
    true    // includeGeometry — required for the buffer/intersect comparison in Step 3
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

for (var p in activeParents) {
    if (p.OBJECTID > highestParentOID) {
        highestParentOID = p.OBJECTID;
        parentFDMID      = p.FDMID;
        parentFromM      = p.FROMMEASURE;
        parentToM        = p.TOMEASURE;
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
// First to fire — claim parentFDMID.  The sister's rule will see this
// assignment when it fires and take the complementary value (Step 2).
if (sisterCount == 0) {
    Console("FDMID Rule [OID " + myOID + "]: first to fire, claiming parentFDMID " + parentFDMID);
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
// Both rules fired before either received its FDMID.  Use a deterministic
// decision tree so both reach the same conclusion regardless of eval order.

var BUFFER_M = 50;

var addrFC = FeatureSetByName(
    $datastore,
    "LND_civic_address",
    ["OBJECTID"],
    true
);

var myBuffer     = Buffer(Geometry($feature), BUFFER_M, "meters");
var sisterBuffer = Buffer(Geometry(sister),    BUFFER_M, "meters");

var myAddrCount     = Count(Intersects(addrFC, myBuffer));
var sisterAddrCount = Count(Intersects(addrFC, sisterBuffer));

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
