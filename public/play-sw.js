/*
 * Service worker Sayplay (P67 T11). Existuje jen proto, aby šel Sayplay nainstalovat jako aplikace do knihovny Questu.
 * Nic neukládá a do požadavků nevstupuje: každý jde rovnou na síť. Stará verze hry z cache by na veřejném demu jen mátla.
 * Registruje ho jen prohlížeč, který umí immersive VR (`src/components/play/xr/RegisterSw.tsx`).
 */

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// Posluchač `fetch` musí existovat, aby prohlížeč worker uznal pro instalaci. Je prázdný a odpověď nepřebírá,
// takže každý požadavek vyřídí prohlížeč sám, přesně jako bez workeru. Worker, který by požadavky posílal na síť
// sám, by každý zdržel a obešel odposlech sítě v e2e (`page.route`).
self.addEventListener('fetch', () => {});
