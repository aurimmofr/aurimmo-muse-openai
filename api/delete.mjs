import {del} from '@vercel/blob';
import {claimSourceAssetDeletion,ownedAssetByPath,validUploadPath} from './_client-data.mjs';
import {requireIdentity} from './_identity.mjs';
import {readJSON,sameOrigin,sendJSON} from './_security.mjs';

export function validPrivatePath(value) {
  return typeof value==='string'&&/^(uploads|results)\/[a-zA-Z0-9._-]+$/.test(value);
}

export function referencedPrivatePaths(records=[]) {
  const paths=new Set();
  for(const record of records){if(validPrivatePath(record?.source_path))paths.add(record.source_path);if(validPrivatePath(record?.result_path))paths.add(record.result_path);}
  return paths;
}

export default async function handler(req,res) {
  if(req.method!=='POST')return sendJSON(res,405,{error:'Méthode non disponible.'});
  if(!sameOrigin(req))return sendJSON(res,403,{error:'Origine refusée.',code:'origin_refused'});
  const identity=await requireIdentity(req,res);if(!identity)return;
  try {
    const body=await readJSON(req,16*1024),paths=body.paths;
    if(!Array.isArray(paths)||paths.length!==1||new Set(paths).size!==paths.length||paths.some(path=>!validUploadPath(path))) {
      return sendJSON(res,400,{error:'Liste de fichiers privés invalide.'});
    }
    const assets=[];
    for(const path of paths) {
      const asset=await ownedAssetByPath(identity,path,{kind:'source_photo',includeDeleted:true});
      if(!asset)return sendJSON(res,404,{error:'Photo privée introuvable.',code:'source_asset_not_found'});
      assets.push(asset);
    }
    for(const asset of assets) {
      const claimed=await claimSourceAssetDeletion(identity,asset.id);
      if(claimed?.deletion_status==='in_use')return sendJSON(res,409,{error:'Cette photo appartient à un rendu conservé et ne peut pas être supprimée.',code:'source_asset_in_use'});
      if(!['claimed','already_deleted'].includes(claimed?.deletion_status)||claimed.blob_path!==asset.blob_path)return sendJSON(res,409,{error:'Cette photo ne peut plus être supprimée.',code:'source_asset_delete_conflict'});
      await del(asset.blob_path);
    }
    return sendJSON(res,200,{removed:paths.length});
  } catch(error) {
    return sendJSON(res,500,{error:'Le fichier privé n’a pas pu être supprimé.',code:error?.code||'source_delete_failed'});
  }
}
