const SHA256=/^[a-f0-9]{64}$/;
const DIAGNOSTIC_REASONS=new Set(['unsupported_visual_typology','ambiguous_multiple_references_same_typology','no_confident_pixel_detection','uncertain_visible_mask','no_safe_visible_interior']);

function exactStringArray(left,right) {
  return Array.isArray(left)&&Array.isArray(right)&&left.length===right.length&&left.every((value,index)=>typeof value==='string'&&value===right[index]);
}

function invalid(reason) {return {valid:false,reason};}

/**
 * Validate a derived hotspot record against the immutable render that produced
 * it. A completed record must account for every frozen catalogue reference:
 * either a local pixel detection exists or the local detector explains why it
 * was omitted. This intentionally never manufactures a fallback coordinate.
 */
export function validateHotspotRecord(record,run) {
  if(!run||typeof run!=='object'||Array.isArray(run))return invalid('run_missing');
  if(run.schema_version!=='aurimmo.public.run.v2'||run.provider!=='muse'||!/^run-[a-zA-Z0-9-]{8,120}$/.test(run.run_id||'')||run.result_path!==`results/${run.run_id}.png`)return invalid('run_contract');
  if(!SHA256.test(run.selection_fingerprint||'')||!Array.isArray(run.product_ids)||new Set(run.product_ids).size!==run.product_ids.length||run.product_ids.some(id=>typeof id!=='string'||!id))return invalid('run_products');
  if(!record||typeof record!=='object'||Array.isArray(record))return invalid('record_missing');
  if(record.schema_version!=='aurimmo.public.hotspots.v1'||record.status!=='completed')return invalid('record_contract');
  if(record.run_id!==run.run_id||record.selection_fingerprint!==run.selection_fingerprint||record.result_path!==run.result_path)return invalid('render_identity');
  if(!exactStringArray(record.product_ids,run.product_ids))return invalid('product_identity');
  if(!SHA256.test(record.image_sha256||'')||!SHA256.test(run.output_sha256||'')||record.image_sha256!==run.output_sha256)return invalid('image_identity');
  if(record.paid_api_calls!==0||record.image_uploads!==0)return invalid('offline_contract');
  if(!Array.isArray(record.hotspots)||!Array.isArray(record.diagnostics))return invalid('localization_contract');

  const allowed=new Set(run.product_ids),accounted=new Set();
  for(const point of record.hotspots) {
    if(!point||typeof point!=='object'||point.catalog_id!==point.candidate_key||!allowed.has(point.catalog_id)||accounted.has(point.catalog_id))return invalid('hotspot_identity');
    if(!Number.isFinite(point.x)||point.x<0||point.x>1||!Number.isFinite(point.y)||point.y<0||point.y>1)return invalid('hotspot_coordinates');
    if(point.position_source!=='automatic_local_detection'||point.human_verified!==false||point.evidence?.sku_fidelity_verified!==false)return invalid('hotspot_provenance');
    accounted.add(point.catalog_id);
  }
  for(const diagnostic of record.diagnostics) {
    const candidate=diagnostic?.candidate_key;
    if(typeof candidate!=='string'||!allowed.has(candidate)||accounted.has(candidate)||!DIAGNOSTIC_REASONS.has(diagnostic.reason))return invalid('diagnostic_identity');
    accounted.add(candidate);
  }
  if(run.product_ids.some(id=>!accounted.has(id)))return invalid('unaccounted_product');
  return {valid:true,reason:null};
}

export function isValidHotspotRecord(record,run) {return validateHotspotRecord(record,run).valid;}

export const __test={exactStringArray,SHA256,DIAGNOSTIC_REASONS};
