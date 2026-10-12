import {requireIdentity} from './_identity.mjs';
import {readJSON,sameOrigin,sendJSON} from './_security.mjs';
import {appBaseURL,safeReturnPath,stripeFetch} from './_stripe.mjs';
import {supabaseUserFetch} from './_supabase.mjs';

const first=value=>Array.isArray(value)?value[0]??null:value??null;

export default async function handler(req,res) {
  if(req.method!=='POST')return sendJSON(res,405,{error:'Méthode non disponible.'});
  if(!sameOrigin(req))return sendJSON(res,403,{error:'Origine refusée.',code:'origin_refused'});
  const identity=await requireIdentity(req,res);if(!identity)return;
  try {
    const body=await readJSON(req,8*1024);
    const rows=await supabaseUserFetch(`billing_customers?select=stripe_customer_id&user_id=eq.${encodeURIComponent(identity.user.id)}&limit=1`,{accessToken:identity.accessToken});
    const customerId=first(rows)?.stripe_customer_id;
    if(!/^cus_[A-Za-z0-9]+$/.test(customerId||''))return sendJSON(res,409,{error:'Aucun espace de facturation n’est encore disponible.',code:'billing_customer_missing'});
    const returnUrl=`${appBaseURL()}${safeReturnPath(body.return_to,'/portal.html')}`;
    const session=await stripeFetch('billing_portal/sessions',{params:{customer:customerId,return_url:returnUrl}});
    if(typeof session?.url!=='string'||!session.url.startsWith('https://'))throw new Error('invalid_portal_url');
    return sendJSON(res,201,{url:session.url});
  } catch(error) {
    const status=Number(error.status)||503;
    return sendJSON(res,status,{error:status>=500?'Portail de facturation momentanément indisponible.':'Le portail de facturation ne peut pas être ouvert.',code:error.code||'billing_portal_failed'});
  }
}
