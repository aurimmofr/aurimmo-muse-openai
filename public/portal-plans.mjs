const SHARED_FEATURES=Object.freeze({
  rooms_per_project:1,
  source:'one_photo',
  catalogue_library:true,
  styles_library:true,
  furniture_library:true,
  finishes_library:true,
  download_retention_hours:24,
  credits_rollover:false,
  trial:false
});

export const PORTAL_PLANS=Object.freeze([
  Object.freeze({
    code:'essential',
    name:'Essentiel',
    images_per_month:10,
    monthly:Object.freeze({amount_cents:999,display_monthly_cents:999}),
    yearly:Object.freeze({amount_cents:7428,display_monthly_cents:619}),
    recommended:false,
    features:SHARED_FEATURES
  }),
  Object.freeze({
    code:'pro',
    name:'Pro',
    images_per_month:100,
    monthly:Object.freeze({amount_cents:3999,display_monthly_cents:3999}),
    yearly:Object.freeze({amount_cents:29988,display_monthly_cents:2499}),
    recommended:true,
    badge:'Le plus choisi',
    features:SHARED_FEATURES
  })
]);

const TERMINAL_SUBSCRIPTION_STATUSES=new Set(['canceled','incomplete_expired']);

export function subscriptionBlocksCheckout(subscription,now=Date.now()) {
  if(!subscription||typeof subscription!=='object')return false;
  const status=String(subscription.status||'').toLowerCase();
  if(TERMINAL_SUBSCRIPTION_STATUSES.has(status))return false;
  if(status!=='active')return true;
  const start=Date.parse(subscription.periodStart??subscription.current_period_start);
  const end=Date.parse(subscription.periodEnd??subscription.current_period_end);
  // A malformed or locally expired active period must reach the server so it
  // can be reconciled against Stripe.  The server still refuses a second live
  // subscription when Stripe confirms that the first one remains active.
  return Number.isFinite(start)&&Number.isFinite(end)&&start<=now&&end>now;
}
