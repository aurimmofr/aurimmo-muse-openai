const UINT32_RANGE=0x1_0000_0000;

export function secureRandomIndex(length,cryptoRef=globalThis.crypto) {
  if(!Number.isSafeInteger(length)||length<1)throw new RangeError('La liste de produits est vide.');
  if(!cryptoRef?.getRandomValues)throw new Error('Le tirage aléatoire sécurisé est indisponible.');
  const limit=UINT32_RANGE-(UINT32_RANGE%length),values=new Uint32Array(1);
  do cryptoRef.getRandomValues(values);while(values[0]>=limit);
  return values[0]%length;
}

export function selectProductsByRole({catalogue,roles,forcedByRole={},currentSelection=[],avoidSelection=[],randomize=false,pickIndex=secureRandomIndex}) {
  if(!Array.isArray(catalogue)||!Array.isArray(roles))throw new TypeError('Catalogue et rôles requis.');
  const current=new Map(currentSelection.map(product=>[product.role,product]));
  const avoid=new Map(avoidSelection.map(product=>[product.role,product.catalog_id]));
  const used=new Set(),selection=[];
  for(const role of roles) {
    const choices=catalogue.filter(product=>product.role===role&&product.selection_status!=='historical_run_only'&&!used.has(product.catalog_id));
    if(!choices.length)throw new Error(`Aucune référence active n’est disponible pour ${role}.`);
    const forced=choices.find(product=>product.catalog_id===forcedByRole[role]);
    const existing=!randomize&&choices.find(product=>product.catalog_id===current.get(role)?.catalog_id);
    let product=forced||existing;
    if(!product) {
      const previousId=avoid.get(role),fresh=previousId&&choices.length>1?choices.filter(candidate=>candidate.catalog_id!==previousId):choices;
      const index=pickIndex(fresh.length);
      if(!Number.isSafeInteger(index)||index<0||index>=fresh.length)throw new RangeError('Index de tirage invalide.');
      product=fresh[index];
    }
    used.add(product.catalog_id);selection.push(product);
  }
  return selection;
}
