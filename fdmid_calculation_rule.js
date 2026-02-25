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
//   (A) Brand-new event  (FDMID arrives as NULL)
//       A user or process creates a new event with no FDMID.
//       → Assign NextSequenceValue("sdeadm.FDMID_LRS")
//
//   (B) LRS event split — "keeper" segment
//       When an event is split, the LRS engine shortens the original record
//       (preserving all its attributes, including FDMID) and INSERTs a new
//       record with the same attributes.  The INSERT rule fires on both
//       resulting records.  One record should keep the original FDMID
//       (continuity of identity); the other receives a new value.
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
//       → Return inherited FDMID unchanged.
//
//   (C) LRS event split — "non-keeper" segment
//       → Assign NextSequenceValue("sdeadm.FDMID_LRS")
//
// =============================================================================


// ── Current feature attributes ────────────────────────────────────────────────
var myFDMID  = $feature.FDMID;
var myOID    = $feature.OBJECTID;
var myLength = $feature.TOMEASURE - $feature.FROMMEASURE;


// ── (A) Brand-new record ──────────────────────────────────────────────────────
if (IsEmpty(myFDMID) || IsNull(myFDMID)) {
    return NextSequenceValue("sdeadm.FDMID_LRS");
}


// ── (B / C) Split scenario ────────────────────────────────────────────────────
// FDMID is non-null on INSERT → LRS copied it from the shortened original record.
// Find the active sister split record: same FDMID, different OID, TODATE IS NULL.

var eventFC = FeatureSetByName(
    $datastore,
    "SDEADM.E_AddressRange",
    ["OBJECTID", "FDMID", "FROMMEASURE", "TOMEASURE", "TODATE"],
    true    // includeGeometry — required for the buffer/intersect comparison below
);

var sisters = Filter(
    eventFC,
    "FDMID = @myFDMID AND OBJECTID <> @myOID AND TODATE IS NULL"
);

// If the sister record is not yet visible in this edit operation, keep the
// inherited FDMID conservatively.  When the sister's rule fires it will
// find this record (which has TODATE IS NULL) and evaluate itself correctly.
if (Count(sisters) == 0) {
    return myFDMID;
}

var sister       = First(sisters);
var sisterOID    = sister.OBJECTID;
var sisterLength = sister.TOMEASURE - sister.FROMMEASURE;


// ── Primary: civic address point density ──────────────────────────────────────
// Civic address points are not coincident with the LRS event line segments,
// so a 50 m buffer is applied before intersecting.  The segment whose buffer
// captures more address points is the keeper — it represents the portion of
// the original address range with the denser civic data.

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


// ── Decision tree ─────────────────────────────────────────────────────────────

// 1. Primary: civic address density
if (myAddrCount > sisterAddrCount) {
    return myFDMID;                                 // I have more → I am the keeper
}
if (sisterAddrCount > myAddrCount) {
    return NextSequenceValue("sdeadm.FDMID_LRS");  // Sister has more → I get new FDMID
}

// 2. Fallback: segment length  (longer segment keeps original FDMID)
if (myLength > sisterLength) {
    return myFDMID;
}
if (sisterLength > myLength) {
    return NextSequenceValue("sdeadm.FDMID_LRS");
}

// 3. Tiebreaker: lower OBJECTID keeps original FDMID
//    Both records evaluate this identically → guaranteed consistent outcome.
if (myOID <= sisterOID) {
    return myFDMID;
}
return NextSequenceValue("sdeadm.FDMID_LRS");
