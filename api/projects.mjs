import {requireIdentity,validUUID} from './_identity.mjs';
import {signedRead} from './_data.mjs';
import {validClientRunId,validResultPath} from './_client-data.mjs';
import {readJSON,sameOrigin,sendJSON} from './_security.mjs';
import {supabaseUserFetch,supabaseUserRpc} from './_supabase.mjs';

const PROPERTY_TYPES=new Map([['apartment','apartment'],['appartement','apartment'],['house','house'],['maison','house'],['studio','studio'],['other','other'],['autre','other']]);
const clean=(value,max)=>typeof value==='string'?value.trim().slice(0,max):'';

function projectInput(body) {
  const value=body.project&&typeof body.project==='object'?body.project:body,name=clean(value.name??value.project_name??value.projectName,100);
  const rawPropertyType=clean(value.property_type??value.propertyType,30).toLowerCase(),propertyType=rawPropertyType?PROPERTY_TYPES.get(rawPropertyType):'other';
  if(name.length<2||!propertyType)throw Object.assign(new Error('Informations du projet invalides.'),{status:400,code:'invalid_project'});
  return {name,propertyType,city:clean(value.city??value.address,120)||null,notes:clean(value.notes,1000)||null};
}

const publicProject=value=>value&&typeof value==='object'?{...value,address:value.city??null}:value;

async function projectsWithGenerations(projects,attempts,assets,ownerId,{sign=signedRead}={}) {
  const safeProjects=Array.isArray(projects)?projects:[],projectIds=new Set(safeProjects.map(project=>project?.id).filter(validUUID));
  const ownedResults=new Set((Array.isArray(assets)?assets:[]).filter(asset=>asset?.owner_id===ownerId&&asset?.kind==='generated_result'&&
    projectIds.has(asset?.project_id)&&validResultPath(asset?.blob_path)).map(asset=>`${asset.project_id}\n${asset.blob_path}`));
  const grouped=new Map([...projectIds].map(id=>[id,[]]));
  for(const attempt of Array.isArray(attempts)?attempts:[]) {
    if(attempt?.user_id!==ownerId||attempt?.status!=='saved'||attempt?.provider!=='muse'||!projectIds.has(attempt?.project_id)||
      !validClientRunId(attempt?.run_id)||!validResultPath(attempt?.result_path)||!ownedResults.has(`${attempt.project_id}\n${attempt.result_path}`))continue;
    const imageUrl=await sign(attempt.result_path);
    grouped.get(attempt.project_id).push({id:attempt.run_id,run_id:attempt.run_id,project_id:attempt.project_id,provider:'muse',
      selection_fingerprint:attempt.selection_fingerprint??null,created_at:attempt.created_at??null,image_url:imageUrl,result_url:imageUrl});
  }
  return safeProjects.map(project=>({...publicProject(project),generations:grouped.get(project.id)??[]}));
}

function query(req,name) {try{return new URL(req.url,'https://aurimmo.local').searchParams.get(name);}catch{return null;}}

export default async function handler(req,res) {
  if(!['GET','POST'].includes(req.method))return sendJSON(res,405,{error:'Méthode non disponible.'});
  if(req.method==='POST'&&!sameOrigin(req))return sendJSON(res,403,{error:'Origine refusée.',code:'origin_refused'});
  const identity=await requireIdentity(req,res);if(!identity)return;
  try {
    if(req.method==='GET') {
      const requested=query(req,'id'),filter=requested?(validUUID(requested)?`&id=eq.${encodeURIComponent(requested)}`:(()=>{throw Object.assign(new Error('Projet invalide.'),{status:400,code:'invalid_project_id'});})()):'';
      const projects=await supabaseUserFetch(`projects?select=id,name,property_type,city,notes,room_type,style,status,created_at,updated_at&owner_id=eq.${encodeURIComponent(identity.user.id)}${filter}&order=updated_at.desc&limit=100`,{accessToken:identity.accessToken});
      const projectRows=Array.isArray(projects)?projects:[];
      if(!projectRows.length)return sendJSON(res,200,{projects:[]});
      const [attempts,assets]=await Promise.all([
        supabaseUserFetch(`generation_attempts?select=run_id,user_id,project_id,provider,selection_fingerprint,status,result_path,created_at&user_id=eq.${encodeURIComponent(identity.user.id)}&status=eq.saved&order=created_at.desc&limit=500`,{accessToken:identity.accessToken}),
        supabaseUserFetch(`assets?select=owner_id,project_id,blob_path,kind&owner_id=eq.${encodeURIComponent(identity.user.id)}&kind=eq.generated_result&deleted_at=is.null&order=created_at.desc&limit=500`,{accessToken:identity.accessToken}),
      ]);
      return sendJSON(res,200,{projects:await projectsWithGenerations(projectRows,attempts,assets,identity.user.id)});
    }
    const value=projectInput(await readJSON(req,24*1024)),result=await supabaseUserRpc('create_client_project',{p_name:value.name,p_property_type:value.propertyType,p_city:value.city,p_notes:value.notes},identity.accessToken);
    const id=typeof result==='string'?result:Array.isArray(result)?result[0]?.create_client_project:result?.create_client_project;
    if(!validUUID(id))throw new Error('invalid_project_id');
    const rows=await supabaseUserFetch(`projects?select=id,name,property_type,city,notes,room_type,style,status,created_at,updated_at&id=eq.${encodeURIComponent(id)}&limit=1`,{accessToken:identity.accessToken});
    return sendJSON(res,201,{project:publicProject(Array.isArray(rows)?rows[0]??{id}:rows||{id})});
  } catch(error) {
    const status=Number(error.status)||503;
    return sendJSON(res,status,{error:status>=500?'Projets momentanément indisponibles.':error.message,code:error.code||'projects_failed'});
  }
}

export const __test={projectInput,publicProject,projectsWithGenerations};
