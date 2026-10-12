import {sendJSON} from './_security.mjs';
import adminClients from '../server/routes/admin-clients.mjs';
import adminReconciliations from '../server/routes/admin-reconciliations.mjs';
import billingCheckout from '../server/routes/billing-checkout.mjs';
import billingPlans from '../server/routes/billing-plans.mjs';
import billingPortal from '../server/routes/billing-portal.mjs';
import clientAuth from '../server/routes/client-auth.mjs';
import deleteSource from '../server/routes/delete.mjs';
import me from '../server/routes/me.mjs';
import onboarding from '../server/routes/onboarding.mjs';
import projects from '../server/routes/projects.mjs';
import status from '../server/routes/status.mjs';

const ROUTES=new Map([
  ['admin-clients',adminClients],
  ['admin-reconciliations',adminReconciliations],
  ['billing-checkout',billingCheckout],
  ['billing-plans',billingPlans],
  ['billing-portal',billingPortal],
  ['client-auth',clientAuth],
  ['delete',deleteSource],
  ['me',me],
  ['onboarding',onboarding],
  ['projects',projects],
  ['status',status],
]);

function routeName(req) {
  const helper=Array.isArray(req.query?.route)?req.query.route[0]:req.query?.route;
  if(typeof helper==='string'&&helper.length<80)return helper;
  try{return new URL(req.url,'https://aurimmo.local').searchParams.get('route');}catch{return null;}
}

export default async function handler(req,res) {
  const route=routeName(req),routeHandler=ROUTES.get(route);
  if(!routeHandler)return sendJSON(res,404,{error:'Route API introuvable.',code:'api_route_not_found'});
  return routeHandler(req,res);
}

export const __test={ROUTES,routeName};
