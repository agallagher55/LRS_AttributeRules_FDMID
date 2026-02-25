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
//       No retired parent record with the same EventId exists.
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
//       a record with the same EventId and TODATE IS NOT NULL.
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


// ── Current feature attributes ────────────────────────────────────────────────
var myOID     = $feature.OBJECTID;
var myLength  = $feature.TOMEASURE - $feature.FROMMEASURE;
var myEventId = $feature.EventId;

var eventFC = FeatureSetByName(
    $datastore,
    "SDEADM.E_AddressRange",
    ["OBJECTID", "FDMID", "FROMMEASURE", "TOMEASURE", "TODATE", "EventId"],
    true    // includeGeometry — required for the buffer/intersect comparison below
);


// ── (A) Brand-new record ──────────────────────────────────────────────────────
// A retired parent with the same EventId indicates a split.  If none exists,
// this is a genuinely new event.
var retiredParents = Filter(eventFC, "EventId = @myEventId AND TODATE IS NOT NULL");

if (Count(retiredParents) == 0) {
    return NextSequenceValue("sdeadm.FDMID_LRS");
}


// ── (B / C) Split scenario ────────────────────────────────────────────────────
// Retrieve the retired parent's FDMID — this is the value one of the two new
// records should keep.
var parentFDMID = First(retiredParents).FDMID;

// Find the active sister split record: same EventId, active (TODATE IS NULL),
// different OBJECTID.
var sisters = Filter(
    eventFC,
    "EventId = @myEventId AND TODATE IS NULL AND OBJECTID <> @myOID"
);

// If the sister record is not yet visible in this edit operation, keep the
// parent FDMID conservatively.  When the sister's rule fires it will
// find this record and evaluate itself correctly.
if (Count(sisters) == 0) {
    return parentFDMID;
}

var sister       = First(sisters);
var sisterOID    = sister.OBJECTID;
var sisterLength = sister.TOMEASURE - sister.FROMMEASURE;


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


// ── Decision tree ─────────────────────────────────────────────────────────────

// 1. Primary: civic address density
if (myAddrCount > sisterAddrCount) {
    return parentFDMID;
}
if (sisterAddrCount > myAddrCount) {
    return NextSequenceValue("sdeadm.FDMID_LRS");
}

// 2. Fallback: segment length  (longer segment keeps original FDMID)
if (myLength > sisterLength) {
    return parentFDMID;
}
if (sisterLength > myLength) {
    return NextSequenceValue("sdeadm.FDMID_LRS");
}

// 3. Tiebreaker: lower OBJECTID keeps original FDMID
//    Both records evaluate this identically → guaranteed consistent outcome.
if (myOID <= sisterOID) {
    return parentFDMID;
}
return NextSequenceValue("sdeadm.FDMID_LRS");
