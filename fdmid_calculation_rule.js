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
//       The INSERT rule fires on both new records sequentially.  One should
//       receive the retired parent's FDMID (continuity of identity); the other
//       gets a new value from the sequence.  A retired parent is detected by
//       querying for a record with the same EVENTID and TODATE IS NOT NULL.
//
//       Because EVENTID persists across repeated splits, multiple retired
//       parents may share the same EVENTID.  The most recently retired record
//       (highest OBJECTID) is used.
//
//       Keeper determination logic (applied in order):
//
//         Step 1 — Sister not yet visible (sisterCount = 0):
//                  This record is the first to fire.  Claim parentFDMID.
//                  When the sister's rule fires, it will find this record
//                  and proceed via Step 2 or 3.
//
//         Step 2 — Sister is visible and already has FDMID assigned:
//                  a. sister.FDMID == parentFDMID  → sister is the keeper;
//                     this record is non-keeper → NextSequenceValue.
//                  b. sister.FDMID != parentFDMID  → sister was already
//                     labelled non-keeper; this record is keeper → parentFDMID.
//
//         Step 3 — Sister is visible but FDMID not yet assigned (concurrent
//                  execution): fall back to the deterministic decision tree:
//                  1. Primary  – whichever segment's 50 m buffer contains MORE
//                                LND_civic_address point features keeps the FDMID.
//                  2. Fallback – if civic-address counts are equal (or both zero),
//                                the longer segment (TOMEASURE − FROMMEASURE) wins.
//                  3. Tiebreak – if lengths are also equal, the lower OBJECTID wins.
//                                (Both records evaluate this identically, so the
//                                 result is conflict-free regardless of eval order.)
//
//       → Return retired parent's FDMID.
//
//   (C) LRS event split — "non-keeper" segment
//       → Assign NextSequenceValue("sdeadm.FDMID_LRS")
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

Console("FDMID Rule [OID " + myOID + "]: sisters found: " + sisterCount);


// ── Step 1: Sister not yet visible ────────────────────────────────────────────
// This record is first to fire (sequential execution).  Claim parentFDMID now.
// When the sister's rule fires it will see this record via Step 2 below.
if (sisterCount == 0) {
    Console("FDMID Rule [OID " + myOID + "]: sister not visible — first to fire, claiming parentFDMID " + parentFDMID);
    return parentFDMID;
}

var sister       = First(sisters);
var sisterOID    = sister.OBJECTID;
var sisterFDMID  = sister.FDMID;
var sisterLength = sister.TOMEASURE - sister.FROMMEASURE;

Console("FDMID Rule [OID " + myOID + "]: sister OID: " + sisterOID + ", sister FDMID: " + sisterFDMID);


// ── Step 2: Sister already has FDMID assigned ─────────────────────────────────
// The first rule has already run and claimed one of the two values.  Determine
// which value this record should take based on what the sister received.
if (!IsEmpty(sisterFDMID)) {
    if (sisterFDMID == parentFDMID) {
        // Sister claimed the parent FDMID → this record is the non-keeper.
        Console("FDMID Rule [OID " + myOID + "]: sister holds parentFDMID — assigning new sequence value");
        return NextSequenceValue("sdeadm.FDMID_LRS");
    }
    // Sister was assigned a new sequence value → sister is the non-keeper,
    // so this record is the keeper.
    Console("FDMID Rule [OID " + myOID + "]: sister holds new FDMID — returning parentFDMID " + parentFDMID);
    return parentFDMID;
}


// ── Step 3: Sister visible but FDMID not yet set (concurrent execution) ───────
// Both rules fired before either received its FDMID.  Use the deterministic
// decision tree so both records reach consistent, non-duplicate conclusions
// regardless of evaluation order.

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
