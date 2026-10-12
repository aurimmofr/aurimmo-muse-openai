import {sendJSON} from './_security.mjs';
import {publicPlans,stripeConfigured,stripeWebhookConfigured} from './_stripe.mjs';

export default function handler(req,res) {
  if(req.method!=='GET')return sendJSON(res,405,{error:'Méthode non disponible.'});
  const plans=publicPlans();
  return sendJSON(res,200,{currency:'EUR',billing_enabled:stripeConfigured()&&stripeWebhookConfigured()&&plans.some(plan=>plan.prices.monthly.available||plan.prices.annual.available),plans});
}
