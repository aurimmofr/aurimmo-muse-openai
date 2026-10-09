import {list} from '@vercel/blob';
import {publicCatalogue,privateJSON,signedRead,validRunId} from './_data.mjs';
import {requireAuth,sendJSON} from './_security.mjs';

export default async function handler(req,res) {
  if(req.method!=='GET')return sendJSON(res,405,{error:'Méthode non disponible.'});
  if(!requireAuth(req,res))return;
  try {
    const [{blobs},{index}]=await Promise.all([list({prefix:'runs/',limit:25}),publicCatalogue()]);
    const ordered=[...blobs].sort((a,b)=>b.uploadedAt-a.uploadedAt),runs=[];
    for(const blob of ordered) {
      const record=await privateJSON(blob.pathname);
      if(!record||!validRunId(record.run_id)||record.status!=='render_saved_visual_review_pending'||!/^results\/run-[a-zA-Z0-9-]{8,120}\.png$/.test(record.result_path||'')||!/^uploads\/[a-zA-Z0-9._-]+$/.test(record.source_path||''))continue;
      const products=(record.product_ids||[]).map(id=>index.get(id)).filter(Boolean);
      if(products.length!==(record.product_ids||[]).length)continue;
      runs.push({run_id:record.run_id,provider:record.provider,program:record.program,include_tv:Boolean(record.include_tv),surfaces:record.surfaces,source_path:record.source_path,source_image_url:await signedRead(record.source_path),
        selection_fingerprint:record.selection_fingerprint,products,image_url:await signedRead(record.result_path),elapsed_ms:record.elapsed_ms,usage:record.usage??null,
        output_sha256:record.output_sha256??null,created_at:record.created_at,cost:record.provider==='muse'?{status:'published_flat_price',usd:.01}:{status:'usage_based_reconcile',usage:record.usage??null}});
    }
    return sendJSON(res,200,{runs});
  }catch{return sendJSON(res,500,{error:'Historique privé indisponible.'});}
}
