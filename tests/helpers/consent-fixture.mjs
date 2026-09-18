// Existing rule regressions run as users who explicitly completed the new service consent.
export function consentFixture(timestamp,mode='kazoku'){
 return {version:'2026-09-18.1',mode,privacyAccepted:true,sensitiveAccepted:true,sharingAccepted:true,subjectBasis:mode==='honnin'?'self':'explained-and-agreed',acceptedAt:timestamp};
}
