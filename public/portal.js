import { PORTAL_PLANS, subscriptionBlocksCheckout } from './portal-plans.mjs';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const views = {
  auth: $('#auth-view'),
  onboarding: $('#onboarding-view'),
  plans: $('#plans-view'),
  dashboard: $('#dashboard-view')
};

const state = {
  authIntent: 'register',
  authEmail: '',
  authenticated: false,
  user: null,
  credits: null,
  subscription: null,
  projects: null,
  projectsUnavailable: false,
  billingPeriod: 'monthly',
  billingAvailable: false,
  availablePlanPeriods: new Map(),
  activeDashboard: 'overview',
  plansOrigin: 'dashboard',
  requestedPlans: false,
  returnAfterLogin: false,
  returnTo: '',
  canGenerate: false,
  cancelledCheckoutSessionId: ''
};

const CANCELLED_CHECKOUT_KEY = 'aurimmo:cancelled-checkout-session';
const CHECKOUT_SESSION_ID = /^cs_(?:test|live)_[A-Za-z0-9]+$/;

function rememberedCancelledCheckout() {
  try {
    const value = sessionStorage.getItem(CANCELLED_CHECKOUT_KEY) || '';
    return CHECKOUT_SESSION_ID.test(value) ? value : '';
  } catch {
    return '';
  }
}

function rememberCancelledCheckout(value = '') {
  const sessionId = CHECKOUT_SESSION_ID.test(String(value || '')) ? String(value) : '';
  state.cancelledCheckoutSessionId = sessionId;
  try {
    if (sessionId) sessionStorage.setItem(CANCELLED_CHECKOUT_KEY, sessionId);
    else sessionStorage.removeItem(CANCELLED_CHECKOUT_KEY);
  } catch {}
}

function text(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function escapeHTML(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
}

function safeImageUrl(value) {
  try {
    const url = new URL(String(value || ''), location.origin);
    if (!['http:', 'https:'].includes(url.protocol)) return '';
    return url.href;
  } catch {
    return '';
  }
}

function safeStripeUrl(value) {
  try {
    const url = new URL(String(value || ''));
    const allowed = url.protocol === 'https:' && (
      url.hostname === 'checkout.stripe.com' ||
      url.hostname === 'billing.stripe.com' ||
      url.hostname.endsWith('.stripe.com')
    );
    return allowed ? url.href : '';
  } catch {
    return '';
  }
}

function formatDate(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' }).format(date);
}

function formatMoney(cents) {
  const amount = number(cents);
  if (amount === null) return '—';
  return new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' }).format(amount / 100);
}

async function api(path, { method = 'GET', body, timeout = 15000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(path, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const raw = await response.text();
    let data = {};
    try { data = raw ? JSON.parse(raw) : {}; } catch { data = {}; }
    if (!response.ok) {
      const error = new Error(text(data.error || data.message, 'Le service est momentanément indisponible.'));
      error.status = response.status;
      error.data = data;
      throw error;
    }
    return data;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('Le service met trop de temps à répondre. Réessayez dans un instant.');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function setBusy(button, busy, busyLabel = 'Chargement…') {
  if (!button) return;
  if (busy) {
    button.dataset.label = button.innerHTML;
    button.disabled = true;
    button.textContent = busyLabel;
  } else {
    button.disabled = false;
    if (button.dataset.label) button.innerHTML = button.dataset.label;
    delete button.dataset.label;
  }
}

function feedback(target, message = '', kind = '') {
  const element = typeof target === 'string' ? $(target) : target;
  if (!element) return;
  element.textContent = message;
  element.classList.toggle('error', kind === 'error');
  element.classList.toggle('success', kind === 'success');
}

function globalFeedback(message = '', kind = '') {
  const element = $('#global-feedback');
  element.hidden = !message;
  element.textContent = message;
  element.classList.toggle('error', kind === 'error');
}

function showView(name, { focus = true } = {}) {
  Object.entries(views).forEach(([key, element]) => { element.hidden = key !== name; });
  const member = name === 'dashboard';
  $('#public-nav').hidden = state.authenticated || name !== 'auth';
  $('#member-header').hidden = !member;
  $('#portal-footer').hidden = member;
  closeMobileMenu();
  window.scrollTo({ top: 0, behavior: 'instant' });
  if (focus) {
    const heading = views[name]?.querySelector('h1, h2');
    if (heading) {
      heading.setAttribute('tabindex', '-1');
      heading.focus({ preventScroll: true });
    }
  }
}

function setAuthIntent(intent) {
  state.authIntent = intent === 'login' ? 'login' : 'register';
  const registering = state.authIntent === 'register';
  $('#register-tab').setAttribute('aria-selected', String(registering));
  $('#login-tab').setAttribute('aria-selected', String(!registering));
  $('#auth-email-panel').setAttribute('aria-labelledby', registering ? 'register-tab' : 'login-tab');
  $('#auth-kicker').textContent = registering ? 'COMMENCER' : 'BON RETOUR PARMI NOUS';
  $('#auth-card-title').textContent = registering ? 'Ouvrez votre espace.' : 'Retrouvez votre espace.';
  $('#auth-card-copy').textContent = registering
    ? 'Saisissez votre e-mail. Nous vous envoyons un lien personnel, sans mot de passe à retenir.'
    : 'Utilisez l’adresse liée à votre compte. Nous vous envoyons un lien de connexion sécurisé.';
  $('#email-submit').innerHTML = `${registering ? 'Créer mon espace' : 'Recevoir mon lien'} <span aria-hidden="true">→</span>`;
  $('#auth-code-panel').hidden = true;
  $('#auth-email-panel').hidden = false;
  feedback('#auth-feedback');
  showView('auth', { focus: false });
  setTimeout(() => $('#auth-email').focus(), 0);
}

function normalizePlans(source) {
  const list = Array.isArray(source) ? source : Object.entries(source || {}).map(([id, value]) => ({ id, ...value }));
  return list.flatMap(plan => {
    const id = text(plan.id || plan.code || plan.plan_id);
    const name = text(plan.name || plan.label);
    const credits = number(plan.credits ?? plan.quota ?? plan.images ?? plan.images_per_month);
    const monthly = number(
      typeof plan.monthly === 'object' ? plan.monthly.display_monthly_cents ?? plan.monthly.amount_cents :
        plan.monthly ?? plan.monthly_cents ?? plan.prices?.monthly
    );
    const yearly = number(
      typeof plan.yearly === 'object' ? plan.yearly.display_monthly_cents ?? plan.yearly.amount_cents :
        plan.yearly ?? plan.yearly_cents_per_month ?? plan.prices?.yearly
    );
    const yearlyTotal = number(typeof plan.yearly === 'object' ? plan.yearly.amount_cents : plan.yearly_total_cents) ?? (yearly === null ? null : yearly * 12);
    if (!id || !name || credits === null || monthly === null || yearly === null) return [];
    return [{ id, name, credits, monthly, yearly, yearlyTotal, featured: Boolean(plan.featured ?? plan.recommended ?? id === 'pro') }];
  });
}

const displayPlans = normalizePlans(PORTAL_PLANS);

function renderPlans() {
  const period = state.billingPeriod;
  const grid = $('#plans-grid');
  if (!displayPlans.length) {
    grid.innerHTML = '<p class="empty-state">Les formules ne sont pas disponibles pour le moment.</p>';
    return;
  }
  const checkoutBlocked = subscriptionBlocksCheckout(state.subscription);
  grid.innerHTML = displayPlans.map(plan => {
    const unit = plan[period];
    const yearlyCopy = period === 'yearly'
      ? `Facturé ${formatMoney(plan.yearlyTotal)} par an`
      : 'Sans engagement · résiliable à tout moment';
    const serverPeriod = period === 'yearly' ? 'annual' : 'monthly';
    const serverAllowsPlan = !checkoutBlocked && state.billingAvailable && state.availablePlanPeriods.get(plan.id)?.has(serverPeriod);
    return `<article class="plan-card${plan.featured ? ' featured' : ''}">
      ${plan.featured ? '<span class="popular-badge">LE PLUS CHOISI</span>' : ''}
      <p class="plan-name">${escapeHTML(plan.name)}</p>
      <p class="plan-price">${escapeHTML(formatMoney(unit))}<small> / mois</small></p>
      <p class="plan-billing">${escapeHTML(yearlyCopy)}</p>
      <p class="plan-credit">${plan.credits} images par mois</p>
      <ul><li>Votre pièce réaménagée à partir d’une photo</li><li>Styles, mobilier et finitions de la bibliothèque</li><li>Téléchargements sécurisés pendant 24 h</li><li>Accès à vos projets et créations</li></ul>
      <button class="button${plan.featured ? ' button-dark' : ''}" type="button" data-checkout-plan="${escapeHTML(plan.id)}" ${serverAllowsPlan ? '' : 'disabled'}>Choisir ${escapeHTML(plan.name)}</button>
    </article>`;
  }).join('');
  const selectedPeriod = period === 'yearly' ? 'annual' : 'monthly';
  const selectedPeriodAvailable = [...state.availablePlanPeriods.values()].some(periods => periods.has(selectedPeriod));
  if (checkoutBlocked) {
    feedback('#plans-feedback', 'Un abonnement existe déjà pour ce compte. Utilisez « Gérer l’abonnement » dans votre espace pour le consulter ou le modifier.', 'error');
  } else if (!state.billingAvailable || !selectedPeriodAvailable) {
    feedback('#plans-feedback', 'Les tarifs sont visibles, mais la souscription pour cette période est temporairement indisponible. Réessayez dans quelques instants.', 'error');
  } else {
    feedback('#plans-feedback');
  }
}

async function loadBillingPlans() {
  state.billingAvailable = false;
  state.availablePlanPeriods = new Map();
  renderPlans();
  try {
    const result = await api('/api/billing-plans');
    const serverPlans = result.plans ?? result.items ?? result;
    for (const plan of Array.isArray(serverPlans) ? serverPlans : []) {
      const id = text(plan.id || plan.code || plan.plan_id);
      if (!id) continue;
      const periods = new Set();
      if (plan.prices?.monthly?.available === true) periods.add('monthly');
      if ((plan.prices?.annual ?? plan.prices?.yearly)?.available === true) periods.add('annual');
      if (periods.size) state.availablePlanPeriods.set(id, periods);
    }
    state.billingAvailable = result.billing_enabled !== false && state.availablePlanPeriods.size > 0;
  } catch {
    state.billingAvailable = false;
  }
  renderPlans();
}

function normalizeUser(data) {
  const account = data?.user || data?.client || data;
  const profile = data?.profile || account?.profile || account;
  if (!account || typeof account !== 'object' || !profile || typeof profile !== 'object') return null;
  const email = text(account.email || data?.email);
  const firstName = text(profile.first_name || profile.firstName || profile.given_name || account.first_name || account.firstName);
  const lastName = text(profile.last_name || profile.lastName || profile.family_name || account.last_name || account.lastName);
  return {
    id: text(account.id || account.client_id || account.user_id),
    email,
    firstName,
    lastName,
    phone: text(profile.phone || account.phone),
    company: text(profile.company_name || profile.company || profile.organization || account.company_name || account.company),
    onboardingComplete: Boolean(data?.onboarding_complete ?? profile.onboarding_complete ?? profile.onboardingComplete)
  };
}

function normalizeCredits(data, user) {
  const source = data?.credits ?? user?.credits;
  if (typeof source === 'number') return { available: source, used: null, quota: null, periodEnd: '' };
  if (!source || typeof source !== 'object') return null;
  const available = number(source.available ?? source.remaining ?? source.balance);
  const quota = number(source.quota ?? source.total ?? source.allowance ?? source.limit);
  const reportedUsed = number(source.used ?? source.consumed ?? data?.entitlements?.consumed_generations);
  const used = reportedUsed ?? (available !== null && quota !== null ? Math.max(0, quota - available) : null);
  if (available === null && used === null && quota === null) return null;
  return {
    available,
    used,
    quota,
    periodEnd: source.period_end || source.periodEnd || source.renews_at || ''
  };
}

function normalizeSubscription(data, user) {
  const source = data?.subscription ?? user?.subscription;
  if (!source || typeof source !== 'object') return null;
  return {
    id: text(source.id || source.subscription_id),
    planId: text(source.plan_id || source.planId || source.plan_code || source.plan?.id),
    planName: text(source.plan_name || source.planName || source.plan?.name),
    status: text(source.status),
    period: text(source.period || source.interval || source.billing_period),
    periodStart: source.period_start || source.periodStart || source.current_period_start || '',
    periodEnd: source.period_end || source.periodEnd || source.current_period_end || '',
    cancelAtPeriodEnd: Boolean(source.cancel_at_period_end ?? source.cancelAtPeriodEnd)
  };
}

function applyEntitlements(data) {
  state.canGenerate = data?.can_generate === true || data?.entitlements?.can_generate === true;
  state.credits = normalizeCredits(data, data?.user || data?.client);
  state.subscription = normalizeSubscription(data, data?.user || data?.client);
  renderAccount();
  renderCredits();
}

const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function waitForGenerationEntitlement() {
  if (state.canGenerate) return true;
  for (const delay of [500, 800, 1200, 1800, 2400]) {
    await wait(delay);
    try {
      const result = await api('/api/me', { timeout: 6000 });
      const user = normalizeUser(result);
      if (user) state.user = user;
      applyEntitlements(result);
      if (state.canGenerate) return true;
    } catch {
      // Stripe peut confirmer avant que le webhook soit appliqué. La boucle reste bornée.
    }
  }
  return false;
}

function normalizeGeneration(item, project) {
  if (!item || typeof item !== 'object') return null;
  return {
    id: text(item.id || item.run_id || item.generation_id),
    projectId: project.id,
    projectName: project.name,
    title: text(item.title || item.style || item.style_name || item.program_label, project.name),
    createdAt: item.created_at || item.createdAt || item.date || '',
    imageUrl: safeImageUrl(item.image_url || item.result_url || item.url || item.thumbnail_url)
  };
}

function normalizeProject(item) {
  if (!item || typeof item !== 'object') return null;
  const id = text(item.id || item.project_id);
  if (!id) return null;
  const project = {
    id,
    name: text(item.name || item.title, 'Projet sans nom'),
    roomType: text(item.room_type || item.roomType || item.room?.type),
    address: text(item.address || item.location_label || item.location?.address),
    createdAt: item.created_at || item.createdAt || '',
    updatedAt: item.updated_at || item.updatedAt || item.created_at || '',
    generations: []
  };
  const source = item.generations || item.renders || item.runs || item.history || [];
  project.generations = (Array.isArray(source) ? source : []).map(entry => normalizeGeneration(entry, project)).filter(Boolean);
  const latest = normalizeGeneration(item.latest_generation || item.latest_render, project);
  if (latest && !project.generations.some(entry => entry.id && entry.id === latest.id)) project.generations.unshift(latest);
  return project;
}

function roomLabel(value) {
  return ({
    living_room: 'Salon', living_dining: 'Salon + repas', dining_room: 'Salle à manger',
    bedroom: 'Chambre', office: 'Bureau', other: 'Autre pièce'
  })[value] || value || 'Pièce à préciser';
}

function generations() {
  if (!Array.isArray(state.projects)) return null;
  return state.projects.flatMap(project => project.generations).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

function projectCard(project) {
  const updated = formatDate(project.updatedAt || project.createdAt);
  const count = project.generations.length;
  const studio = `/studio.html?project=${encodeURIComponent(project.id)}`;
  return `<article class="project-card">
    <div class="project-card-top"><span class="project-icon" aria-hidden="true">⌂</span>${updated ? `<time datetime="${escapeHTML(project.updatedAt || project.createdAt)}">${escapeHTML(updated)}</time>` : ''}</div>
    <h3>${escapeHTML(project.name)}</h3>
    <p>${escapeHTML(roomLabel(project.roomType))}${project.address ? ` · ${escapeHTML(project.address)}` : ''}</p>
    <div class="project-card-actions"><a href="${studio}">Ouvrir le studio →</a><span>${count} création${count === 1 ? '' : 's'}</span></div>
  </article>`;
}

function historyCard(item) {
  const date = formatDate(item.createdAt);
  const image = item.imageUrl
    ? `<a class="history-image" href="${escapeHTML(item.imageUrl)}" target="_blank" rel="noopener"><img src="${escapeHTML(item.imageUrl)}" alt="${escapeHTML(item.title)}" loading="lazy"></a>`
    : '<div class="history-image" aria-label="Aperçu indisponible">Aperçu indisponible</div>';
  return `<article class="history-card">${image}<h3>${escapeHTML(item.title)}</h3><p>${escapeHTML(item.projectName)}${date ? ` · ${escapeHTML(date)}` : ''}</p></article>`;
}

function renderProjects() {
  const recent = $('#recent-projects');
  const all = $('#all-projects');
  if (state.projectsUnavailable) {
    const unavailable = '<p class="empty-state">Vos projets sont temporairement indisponibles. Aucune donnée locale n’est affichée à leur place.</p>';
    recent.innerHTML = unavailable;
    all.innerHTML = unavailable;
    return;
  }
  if (!Array.isArray(state.projects)) {
    recent.innerHTML = '<p class="empty-state">Chargement de vos projets…</p>';
    all.innerHTML = '<p class="empty-state">Chargement de vos projets…</p>';
    return;
  }
  if (!state.projects.length) {
    const empty = '<p class="empty-state">Aucun projet pour le moment. Créez votre premier dossier pour ouvrir le studio.</p>';
    recent.innerHTML = empty;
    all.innerHTML = empty;
    return;
  }
  const ordered = [...state.projects].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  recent.innerHTML = ordered.slice(0, 3).map(projectCard).join('');
  all.innerHTML = ordered.map(projectCard).join('');
}

function renderHistory() {
  const recent = $('#recent-history');
  const all = $('#all-history');
  const items = generations();
  if (state.projectsUnavailable) {
    const unavailable = '<p class="empty-state">Votre historique est temporairement indisponible. Aucun résultat fictif n’est affiché.</p>';
    recent.innerHTML = unavailable;
    all.innerHTML = unavailable;
    return;
  }
  if (items === null) return;
  if (!items.length) {
    const empty = '<p class="empty-state">Votre première création apparaîtra ici après son enregistrement dans le studio.</p>';
    recent.innerHTML = empty;
    all.innerHTML = empty;
    return;
  }
  recent.innerHTML = items.slice(0, 4).map(historyCard).join('');
  all.innerHTML = items.map(historyCard).join('');
}

function renderAccount() {
  const user = state.user;
  if (!user) return;
  const fullName = [user.firstName, user.lastName].filter(Boolean).join(' ') || 'Mon compte';
  const initial = (user.firstName || user.email || 'A').slice(0, 1).toUpperCase();
  const planName = state.subscription?.planName || displayPlans.find(plan => plan.id === state.subscription?.planId)?.name || '';
  $('#header-user-name').textContent = fullName;
  $('#header-plan-name').textContent = planName || 'Offre non disponible';
  $('#header-avatar').textContent = initial;
  $('#account-avatar').textContent = initial;
  $('#account-full-name').textContent = fullName;
  $('#account-email').textContent = user.email || 'Adresse e-mail indisponible';
  $('#account-company').textContent = user.company;
  $('#overview-first-name').textContent = user.firstName || '';
  $('#account-plan-copy').textContent = planName || 'Informations indisponibles';
}

function renderCredits() {
  const credits = state.credits;
  const subscription = state.subscription;
  const planName = subscription?.planName || displayPlans.find(plan => plan.id === subscription?.planId)?.name || '';
  $('#metric-plan').textContent = planName || '—';
  $('#billing-plan-name').textContent = planName || 'Informations indisponibles';
  $('#billing-portal-button').disabled = !subscription;
  if (subscription) {
    const end = formatDate(subscription.periodEnd);
    const status = subscription.cancelAtPeriodEnd
      ? `Résiliation enregistrée${end ? ` · accès jusqu’au ${end}` : ''}`
      : `${subscription.status === 'active' ? 'Abonnement actif' : text(subscription.status, 'État à confirmer')}${end ? ` · prochaine échéance le ${end}` : ''}`;
    $('#billing-plan-status').textContent = status;
  } else {
    $('#billing-plan-status').textContent = 'Aucun abonnement actif confirmé.';
  }
  if (!credits) {
    $('#metric-credits').textContent = '—';
    $('#metric-credits-detail').textContent = 'Informations indisponibles';
    $('#header-credit-badge').textContent = 'Crédits indisponibles';
    $('#billing-credit-count').textContent = '—';
    $('#billing-credit-copy').textContent = 'Informations indisponibles pour le moment.';
    $('#billing-renewal').textContent = 'Date de renouvellement indisponible';
    $('#billing-credit-progress').style.width = '0%';
    return;
  }
  const available = credits.available;
  const availableCopy = available === null ? '—' : String(available);
  $('#metric-credits').textContent = availableCopy;
  $('#billing-credit-count').textContent = availableCopy;
  $('#header-credit-badge').textContent = available === null ? 'Crédits indisponibles' : `${available} crédit${available === 1 ? '' : 's'}`;
  if (credits.used !== null && credits.quota !== null) {
    $('#metric-credits-detail').textContent = `${credits.used} utilisé${credits.used === 1 ? '' : 's'} sur ${credits.quota}`;
    $('#billing-credit-copy').textContent = `${credits.used} utilisé${credits.used === 1 ? '' : 's'} sur ${credits.quota} pendant cette période.`;
    const percent = credits.quota > 0 ? Math.min(100, Math.max(0, credits.used / credits.quota * 100)) : 0;
    $('#billing-credit-progress').style.width = `${percent}%`;
    $('.credit-progress').setAttribute('aria-valuenow', String(Math.round(percent)));
  } else {
    $('#metric-credits-detail').textContent = 'disponibles';
    $('#billing-credit-copy').textContent = 'Votre solde disponible.';
    $('#billing-credit-progress').style.width = '0%';
  }
  const creditReset = formatDate(credits.periodEnd);
  const subscriptionRenewal = formatDate(subscription?.periodEnd);
  const samePeriodEnd = Number.isFinite(Date.parse(credits.periodEnd)) && Date.parse(credits.periodEnd) === Date.parse(subscription?.periodEnd);
  $('#billing-renewal').textContent = creditReset && subscriptionRenewal && !samePeriodEnd
    ? `Crédits renouvelés le ${creditReset} · abonnement jusqu’au ${subscriptionRenewal}`
    : creditReset || subscriptionRenewal
      ? `Renouvellement le ${creditReset || subscriptionRenewal}`
      : 'Date de renouvellement indisponible';
}

function renderMetrics() {
  const items = generations();
  $('#metric-projects').textContent = Array.isArray(state.projects) ? String(state.projects.length) : '—';
  $('#metric-generations').textContent = Array.isArray(items) ? String(items.length) : '—';
  $('#sidebar-project-count').textContent = Array.isArray(state.projects) && state.projects.length ? String(state.projects.length) : '';
  $('#sidebar-history-count').textContent = Array.isArray(items) && items.length ? String(items.length) : '';
}

function renderDashboard() {
  renderAccount();
  renderCredits();
  renderMetrics();
  renderProjects();
  renderHistory();
}

async function loadProjects() {
  state.projectsUnavailable = false;
  try {
    const result = await api('/api/projects');
    const list = result.projects ?? result.items ?? [];
    state.projects = (Array.isArray(list) ? list : []).map(normalizeProject).filter(Boolean);
  } catch (error) {
    state.projects = null;
    state.projectsUnavailable = true;
    globalFeedback(error.message, 'error');
  }
  renderDashboard();
}

function needsOnboarding(data, user) {
  if (data?.needs_onboarding === true || data?.onboarding_required === true) return true;
  if (data?.onboarding_complete === false || user?.onboardingComplete === false) return true;
  return !user?.firstName || !user?.lastName;
}

async function loadAccount({ afterAuth = false } = {}) {
  const result = await api('/api/me');
  const user = normalizeUser(result);
  if (!user) throw new Error('Votre compte n’a pas pu être chargé.');
  state.authenticated = true;
  state.user = user;
  applyEntitlements(result);
  if (needsOnboarding(result, user)) {
    $('#onboarding-first-name').value = user.firstName;
    $('#onboarding-last-name').value = user.lastName;
    $('#onboarding-phone').value = user.phone;
    $('#onboarding-company').value = user.company;
    showView('onboarding');
    return;
  }
  if (state.returnAfterLogin && state.returnTo) {
    location.assign(state.returnTo);
    return;
  }
  await loadProjects();
  if (state.requestedPlans) {
    state.plansOrigin = state.returnTo ? 'studio' : 'dashboard';
    $('#plans-back-button').hidden = false;
    $('#plans-back-button').textContent = state.returnTo ? '← Retour au studio' : '← Retour à mon espace';
    showView('plans');
    await loadBillingPlans();
    return;
  }
  showView('dashboard');
  showDashboard('overview');
  if (afterAuth) globalFeedback('Connexion réussie. Bienvenue dans votre espace.');
}

function showDashboard(target) {
  const allowed = ['overview', 'projects', 'history', 'billing', 'account'];
  const name = allowed.includes(target) ? target : 'overview';
  state.activeDashboard = name;
  $$('.dashboard-panel').forEach(panel => { panel.hidden = panel.id !== `dashboard-${name}`; });
  $$('[data-dashboard-target]').forEach(control => {
    if (control.closest('.dashboard-sidebar')) control.setAttribute('aria-current', control.dataset.dashboardTarget === name ? 'page' : 'false');
  });
  closeMobileMenu();
  window.scrollTo({ top: 0, behavior: 'instant' });
  const heading = $(`#dashboard-${name} h1`);
  if (heading) { heading.setAttribute('tabindex', '-1'); heading.focus({ preventScroll: true }); }
}

function openMobileMenu() {
  $('#member-mobile-menu').hidden = false;
  $('#mobile-menu-button').setAttribute('aria-expanded', 'true');
  document.body.classList.add('menu-open');
}

function closeMobileMenu() {
  $('#member-mobile-menu').hidden = true;
  $('#mobile-menu-button').setAttribute('aria-expanded', 'false');
  document.body.classList.remove('menu-open');
}

async function requestCode(event) {
  event.preventDefault();
  const email = $('#auth-email').value.trim().toLowerCase();
  const button = $('#email-submit');
  setBusy(button, true, 'Envoi du lien…');
  feedback('#auth-feedback');
  try {
    await api('/api/client-auth', { method: 'POST', body: { action: 'request_code', intent: state.authIntent, email } });
    state.authEmail = email;
    $('#code-email').textContent = email;
    $('#auth-email-panel').hidden = true;
    $('#auth-code-panel').hidden = false;
    $('#auth-code').value = '';
    feedback('#auth-feedback', 'E-mail envoyé. Cliquez sur le lien sécurisé reçu ; si votre e-mail affiche un code à 6 chiffres, vous pouvez aussi le saisir ici.', 'success');
    $('#auth-code').focus();
  } catch (error) {
    feedback('#auth-feedback', error.message, 'error');
  } finally {
    setBusy(button, false);
  }
}

async function verifyCode(event) {
  event.preventDefault();
  const button = $('#code-submit');
  setBusy(button, true, 'Vérification…');
  feedback('#auth-feedback');
  try {
    const result = await api('/api/client-auth', {
      method: 'POST',
      body: { action: 'verify_code', intent: state.authIntent, email: state.authEmail, code: $('#auth-code').value.trim() }
    });
    state.authenticated = result.authenticated !== false;
    await loadAccount({ afterAuth: true });
  } catch (error) {
    feedback('#auth-feedback', error.message, 'error');
  } finally {
    setBusy(button, false);
  }
}

async function resendCode() {
  const button = $('#resend-code-button');
  setBusy(button, true, 'Nouvel envoi…');
  try {
    await api('/api/client-auth', { method: 'POST', body: { action: 'request_code', intent: state.authIntent, email: state.authEmail } });
    feedback('#auth-feedback', 'Un nouvel e-mail de connexion vient d’être envoyé.', 'success');
  } catch (error) {
    feedback('#auth-feedback', error.message, 'error');
  } finally {
    setBusy(button, false);
  }
}

async function establishMagicLinkSession() {
  if (!location.hash || location.hash.length > 20000) return false;
  const params = new URLSearchParams(location.hash.slice(1));
  const accessToken = params.get('access_token');
  const refreshToken = params.get('refresh_token');
  const authError = params.get('error_description') || params.get('error');
  history.replaceState(null, '', `${location.pathname}${location.search}`);
  if (authError) throw new Error('Ce lien de connexion a expiré ou n’est plus valide. Demandez un nouvel e-mail.');
  if (!accessToken || !refreshToken) return false;
  await api('/api/client-auth', {
    method: 'POST',
    body: {
      action: 'establish_session',
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_in: Number(params.get('expires_in')) || 3600
    }
  });
  return true;
}

async function submitOnboarding(event) {
  event.preventDefault();
  const button = $('#onboarding-submit');
  setBusy(button, true, 'Enregistrement…');
  feedback('#onboarding-feedback');
  const body = {
    profile: {
      first_name: $('#onboarding-first-name').value.trim(),
      last_name: $('#onboarding-last-name').value.trim(),
      phone: $('#onboarding-phone').value.trim(),
      company: $('#onboarding-company').value.trim()
    },
    project: {
      name: $('#onboarding-project-name').value.trim(),
      room_type: $('#onboarding-room-type').value,
      address: $('#onboarding-address').value.trim()
    },
    terms_accepted: $('#onboarding-terms').checked
  };
  try {
    const result = await api('/api/onboarding', { method: 'POST', body });
    const returnedProjects = result.projects || (result.project ? [result.project] : []);
    state.projects = returnedProjects.map(normalizeProject).filter(Boolean);
    const projectId = text(result.project_id || result.project?.id || result.project?.project_id || state.projects[0]?.id);
    const target = projectId ? `/studio.html?project=${encodeURIComponent(projectId)}` : '/studio.html';
    location.assign(target);
  } catch (error) {
    feedback('#onboarding-feedback', error.message, 'error');
  } finally {
    setBusy(button, false);
  }
}

async function createProject(event) {
  event.preventDefault();
  const button = $('#new-project-form button[type="submit"]');
  setBusy(button, true, 'Création…');
  feedback('#project-form-feedback');
  try {
    await api('/api/projects', {
      method: 'POST',
      body: {
        name: $('#new-project-name').value.trim(),
        room_type: $('#new-project-room').value,
        address: $('#new-project-address').value.trim()
      }
    });
    $('#new-project-form').reset();
    $('#new-project-form').hidden = true;
    await loadProjects();
    globalFeedback('Votre nouveau projet est prêt.');
  } catch (error) {
    feedback('#project-form-feedback', error.message, 'error');
  } finally {
    setBusy(button, false);
  }
}

async function startCheckout(planId) {
  const button = $(`[data-checkout-plan="${CSS.escape(planId)}"]`);
  setBusy(button, true, 'Ouverture du paiement…');
  feedback('#plans-feedback');
  try {
    const result = await api('/api/billing-checkout', {
      method: 'POST',
      body: {
        plan_id: planId,
        period: state.billingPeriod,
        return_to: state.returnTo || '/studio.html',
        ...(state.cancelledCheckoutSessionId ? { replace_checkout_session_id: state.cancelledCheckoutSessionId } : {})
      }
    });
    const url = safeStripeUrl(result.url || result.checkout_url);
    if (!url) throw new Error('La page de paiement reçue n’est pas valide.');
    rememberCancelledCheckout(result.checkout_session_id);
    location.assign(url);
  } catch (error) {
    feedback('#plans-feedback', error.message, 'error');
    setBusy(button, false);
  }
}

async function openBillingPortal() {
  const button = $('#billing-portal-button');
  setBusy(button, true, 'Ouverture…');
  try {
    const result = await api('/api/billing-portal', { method: 'POST', body: {} });
    const url = safeStripeUrl(result.url || result.portal_url);
    if (!url) throw new Error('Le portail de facturation reçu n’est pas valide.');
    location.assign(url);
  } catch (error) {
    globalFeedback(error.message, 'error');
    setBusy(button, false);
  }
}

async function logout() {
  const button = $('#logout-button');
  setBusy(button, true, 'Déconnexion…');
  try {
    await api('/api/client-auth', { method: 'DELETE' });
    state.authenticated = false;
    state.user = null;
    state.credits = null;
    state.subscription = null;
    state.projects = null;
    state.canGenerate = false;
    setAuthIntent('login');
    globalFeedback('Vous êtes déconnecté.');
  } catch (error) {
    globalFeedback(error.message || 'La déconnexion n’a pas pu être confirmée.', 'error');
  } finally {
    setBusy(button, false);
  }
}

function wireEvents() {
  $$('[data-auth-intent]').forEach(button => button.addEventListener('click', () => setAuthIntent(button.dataset.authIntent)));
  $('#email-form').addEventListener('submit', requestCode);
  $('#code-form').addEventListener('submit', verifyCode);
  $('#resend-code-button').addEventListener('click', resendCode);
  $('#change-email-button').addEventListener('click', () => {
    $('#auth-code-panel').hidden = true;
    $('#auth-email-panel').hidden = false;
    feedback('#auth-feedback');
    $('#auth-email').focus();
  });
  $('#onboarding-form').addEventListener('submit', submitOnboarding);
  $$('[data-billing-period]').forEach(button => button.addEventListener('click', () => {
    state.billingPeriod = button.dataset.billingPeriod;
    $$('[data-billing-period]').forEach(option => option.setAttribute('aria-pressed', String(option === button)));
    renderPlans();
  }));
  $('#plans-grid').addEventListener('click', event => {
    const button = event.target.closest('[data-checkout-plan]');
    if (button && !button.disabled) startCheckout(button.dataset.checkoutPlan);
  });
  $$('[data-dashboard-target]').forEach(control => control.addEventListener('click', () => showDashboard(control.dataset.dashboardTarget)));
  $('#mobile-menu-button').addEventListener('click', () => {
    if ($('#member-mobile-menu').hidden) openMobileMenu(); else closeMobileMenu();
  });
  $('#new-project-button').addEventListener('click', () => {
    $('#new-project-form').hidden = false;
    $('#new-project-name').focus();
  });
  $('#cancel-project-button').addEventListener('click', () => { $('#new-project-form').hidden = true; feedback('#project-form-feedback'); });
  $('#new-project-form').addEventListener('submit', createProject);
  $('#billing-portal-button').addEventListener('click', openBillingPortal);
  $('#show-plans-button').addEventListener('click', () => {
    state.plansOrigin = 'dashboard';
    state.returnTo = '';
    state.requestedPlans = true;
    $('#plans-back-button').hidden = false;
    $('#plans-back-button').textContent = '← Retour à mon espace';
    showView('plans');
    loadBillingPlans();
  });
  $('#plans-back-button').addEventListener('click', () => {
    if (state.plansOrigin === 'studio' && state.returnTo) {
      location.assign(state.returnTo);
      return;
    }
    state.requestedPlans = false;
    showView('dashboard');
    showDashboard('billing');
  });
  $('#logout-button').addEventListener('click', logout);
  document.addEventListener('keydown', event => { if (event.key === 'Escape') closeMobileMenu(); });
}

async function initialize() {
  wireEvents();
  renderPlans();
  const query = new URLSearchParams(location.search);
  state.cancelledCheckoutSessionId = rememberedCancelledCheckout();
  state.requestedPlans = query.get('view') === 'plans';
  state.returnAfterLogin = query.get('view') === 'login';
  try {
    const requestedReturn = new URL(query.get('return_to') || '', location.origin);
    if (requestedReturn.origin === location.origin && ['/studio.html', '/admin.html'].includes(requestedReturn.pathname)) {
      state.returnTo = requestedReturn.pathname + requestedReturn.search + requestedReturn.hash;
    }
  } catch {
    state.returnTo = '';
  }
  try {
    const magicLinkCompleted = await establishMagicLinkSession();
    const session = await api('/api/client-auth');
    if (!session.authenticated) {
      showView('auth', { focus: false });
      setAuthIntent(query.get('login') === '1' || query.get('view') === 'login' ? 'login' : 'register');
      return;
    }
    state.authenticated = true;
    await loadAccount({ afterAuth: magicLinkCompleted });
    if (['overview', 'projects', 'history', 'billing', 'account'].includes(query.get('view')) && !state.requestedPlans) {
      showView('dashboard');
      showDashboard(query.get('view'));
    }
    if (query.get('checkout') === 'success' || query.get('billing') === 'success') {
      rememberCancelledCheckout();
      globalFeedback('Paiement reçu. Nous confirmons maintenant l’activation de votre formule…');
      const activated = await waitForGenerationEntitlement();
      query.delete('checkout');
      query.delete('billing');
      query.delete('session_id');
      history.replaceState(null, '', `/portal.html${query.size ? `?${query}` : ''}`);
      if (activated && state.returnTo === '/admin.html') {
        location.assign(state.returnTo);
        return;
      }
      if (activated && state.returnTo.startsWith('/studio.html')) {
        location.assign(state.returnTo);
        return;
      }
      if (activated) {
        globalFeedback('Votre formule est active. Vos crédits confirmés sont affichés dans votre espace.');
        showView('dashboard');
        showDashboard('billing');
      } else {
        globalFeedback('Le paiement est revenu, mais l’activation des crédits n’est pas encore confirmée. Votre projet reste enregistré ; actualisez cette page dans un instant.', 'error');
        state.requestedPlans = true;
        showView('plans');
      }
    } else if (query.get('checkout') === 'cancelled' || query.get('billing') === 'cancelled') {
      rememberCancelledCheckout(query.get('session_id') || state.cancelledCheckoutSessionId);
      globalFeedback('Paiement interrompu. Aucun changement d’offre n’est affiché tant qu’il n’est pas confirmé.');
      query.delete('checkout');
      query.delete('billing');
      query.delete('session_id');
      history.replaceState(null, '', `/portal.html${query.size ? `?${query}` : ''}`);
      if (!state.returnTo) showDashboard('billing');
    }
  } catch (error) {
    if (error.status === 401) {
      state.authenticated = false;
      showView('auth', { focus: false });
      setAuthIntent('login');
      return;
    }
    showView('auth', { focus: false });
    setAuthIntent('login');
    feedback('#auth-feedback', 'La connexion est momentanément indisponible. Vos données ne sont pas simulées.', 'error');
  }
}

initialize();
