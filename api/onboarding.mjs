import {requireIdentity,validUUID} from './_identity.mjs';
import {readJSON,sameOrigin,sendJSON} from './_security.mjs';
import {supabaseUserRpc} from './_supabase.mjs';

const clean=(value,max)=>typeof value==='string'?value.trim().slice(0,max):'';
const PROPERTY_TYPES=new Map([
  ['apartment','apartment'],['appartement','apartment'],['house','house'],['maison','house'],['studio','studio'],['other','other'],['autre','other'],
]);

function input(body) {
  const profile=body.profile&&typeof body.profile==='object'?body.profile:body,project=body.project&&typeof body.project==='object'?body.project:body;
  const firstName=clean(profile.first_name??profile.firstName,80),lastName=clean(profile.last_name??profile.lastName,80);
  const projectName=clean(project.name??project.project_name??project.projectName,100),rawPropertyType=clean(project.property_type??project.propertyType,30).toLowerCase();
  const propertyType=rawPropertyType?PROPERTY_TYPES.get(rawPropertyType):'other';
  if(firstName.length<1||lastName.length<1)throw Object.assign(new Error('Prénom et nom sont requis.'),{status:400,code:'invalid_profile'});
  if(projectName.length<2||!propertyType)throw Object.assign(new Error('Informations du projet invalides.'),{status:400,code:'invalid_project'});
  if(body.terms_accepted!==true&&body.accept_terms!==true)throw Object.assign(new Error('L’acceptation des conditions est requise.'),{status:400,code:'terms_required'});
  return {firstName,lastName,companyName:clean(profile.company_name??profile.companyName??profile.company,120)||null,phone:clean(profile.phone,40)||null,
    projectName,propertyType,city:clean(project.city??project.address,120)||null,notes:clean(project.notes,1000)||null};
}

export default async function handler(req,res) {
  if(req.method!=='POST')return sendJSON(res,405,{error:'Méthode non disponible.'});
  if(!sameOrigin(req))return sendJSON(res,403,{error:'Origine refusée.',code:'origin_refused'});
  const identity=await requireIdentity(req,res);if(!identity)return;
  try {
    const values=input(await readJSON(req,32*1024)),termsVersion=process.env.CLIENT_TERMS_VERSION||'2026-10-12';
    const result=await supabaseUserRpc('complete_client_onboarding',{p_first_name:values.firstName,p_last_name:values.lastName,p_company_name:values.companyName,p_phone:values.phone,
      p_terms_version:termsVersion,p_project_name:values.projectName,p_property_type:values.propertyType,p_city:values.city,p_notes:values.notes},identity.accessToken);
    const projectId=typeof result==='string'?result:Array.isArray(result)?result[0]?.complete_client_onboarding:result?.complete_client_onboarding;
    if(!validUUID(projectId))throw new Error('invalid_project_id');
    return sendJSON(res,201,{onboarding_complete:true,project_id:projectId});
  } catch(error) {
    const status=Number(error.status)||400;
    return sendJSON(res,status,{error:status>=500?'Onboarding momentanément indisponible.':error.message||'Informations invalides.',code:error.code||'onboarding_failed'});
  }
}

export const __test={input,PROPERTY_TYPES};
