/**
 * Výplň sad bez vegetace (P54B T7): stejné tři vrstvy jako vegetace (`Flora`, kreslí
 * `Vegetation.tsx`), jen modely, které místo dělají. Řada kulis vedle nich zůstane hustá
 * (`fill`). Druhy nejsou rekvizity sady – každý přidá scéně model. Hustota je nižší než
 * u louky (0,45): výplň doplňuje řadu kulis a město-závod je na hraně snímků telefonu.
 *
 * Modely jsou gen3d s barvou ve vrcholech (šedou palety katalogu přebarví listím jen
 * `cc0-grass` a `cc0-bush`). Vyřazené pro fialový nádech: `gen3d-large-boulder`,
 * `gen3d-crystal-spire`, `gen3d-coral-reef-rock`, `gen3d-sea-urchin`, `gen3d-bonsai-tree`.
 * Kříž katalog nemá – hřbitov nese rozbité náhrobky. Drobnost u cesty je nižší než 1,4 m
 * (× velikost 1,4 < 2 m, přes ni kamera arény vidí na paty hrdiny).
 */

import type { Flora } from './index';

/** Hrad: louka u hradeb – tráva, květy, keře, kameny a listnáče. */
export const CASTLE_FILL: Flora = {
  near: [
    { id: 'cc0-grass', height: 0.7 },
    { id: 'cc0-grass', height: 0.7 },
    { id: 'gen3d-tall-grass-tuft', height: 0.9 },
    { id: 'gen3d-wildflower-patch', height: 0.45 },
    { id: 'cc0-bush', height: 1.1 },
    { id: 'gen3d-thorn-bush', height: 1 },
    { id: 'gen3d-mossy-rock-cluster', height: 0.9 },
    { id: 'gen3d-river-boulder', height: 0.8 },
  ],
  mid: [
    { id: 'oak-tree', height: 6.5 },
    { id: 'gen3d-beech-tree', height: 6.5 },
    { id: 'gen3d-mossy-boulder', height: 1.4 },
  ],
  far: [
    { id: 'oak-tree', height: 7.5 },
    { id: 'gen3d-beech-tree', height: 7.5 },
    { id: 'gen3d-poplar-tree', height: 9 },
  ],
  leaf: '#4d7c2f',
  density: 0.35,
  fill: true,
};

/** Město: stromy v květnících, lampy, lavičky, keře a sloupky u chodníku. Bez linie v dálce – tu dělají domy kulisy. */
export const CITY_FILL: Flora = {
  near: [
    { id: 'gen3d-planter-box', height: 0.8 },
    { id: 'gen3d-flower-box', height: 0.6 },
    { id: 'cc0-bush', height: 1 },
    { id: 'gen3d-park-bench', height: 0.9 },
    { id: 'gen3d-street-bollard', height: 0.9 },
    { id: 'gen3d-street-trash-can', height: 1 },
  ],
  mid: [
    { id: 'gen3d-concrete-planter-with-tree', height: 3.5 },
    { id: 'gen3d-concrete-planter-with-tree', height: 3.5 },
    { id: 'gen3d-street-tree', height: 5.5 },
    { id: 'gen3d-street-lamp', height: 4.5 },
  ],
  far: [],
  leaf: '#4f8a3a',
  density: 0.22,
  fill: true,
};

/** Hřbitov: holé a strašidelné stromy, rozbité náhrobky, urny, trnité keře. */
export const GRAVEYARD_FILL: Flora = {
  near: [
    { id: 'gen3d-broken-gravestone', height: 1 },
    { id: 'gen3d-broken-gravestone', height: 1 },
    { id: 'gen3d-thorn-bush', height: 1 },
    { id: 'cc0-bush', height: 0.9 },
    { id: 'cc0-grass', height: 0.6 },
    { id: 'gen3d-funeral-urn', height: 0.8 },
    { id: 'gen3d-cemetery-bench', height: 0.9 },
  ],
  mid: [
    { id: 'gen3d-haunted-tree', height: 5 },
    { id: 'gen3d-bare-winter-tree', height: 5 },
    { id: 'gen3d-dead-desert-tree', height: 3.5 },
  ],
  far: [
    { id: 'gen3d-haunted-tree', height: 6.5 },
    { id: 'gen3d-bare-winter-tree', height: 6 },
  ],
  leaf: '#3d5a3a',
  density: 0.35,
  fill: true,
};

/** Vesmír: měsíční kameny, krátery, meteority, krystaly a skalní věže. */
export const SPACE_FILL: Flora = {
  near: [
    { id: 'gen3d-moon-rock', height: 0.8 },
    { id: 'gen3d-crater-rock', height: 0.6 },
    { id: 'gen3d-meteorite', height: 0.8 },
    { id: 'gen3d-energy-crystal', height: 1 },
    { id: 'gen3d-scree-rock-pile', height: 0.6 },
  ],
  mid: [
    { id: 'gen3d-rock-pillar', height: 4 },
    { id: 'gen3d-basalt-column-rock', height: 3 },
    { id: 'gen3d-power-crystal', height: 2 },
    { id: 'gen3d-crystal-cluster', height: 1.6 },
  ],
  far: [
    { id: 'gen3d-rock-pillar', height: 6 },
    { id: 'gen3d-basalt-column-rock', height: 4.5 },
  ],
  leaf: '#8a7560',
  density: 0.3,
  fill: true,
};

/** Sopka: lávové kameny, obsidián, doutnající pařezy a spálené stromy. */
export const VOLCANO_FILL: Flora = {
  near: [
    { id: 'gen3d-volcanic-rock', height: 0.8 },
    { id: 'gen3d-volcanic-rock', height: 0.8 },
    { id: 'gen3d-obsidian-shard', height: 0.9 },
    { id: 'gen3d-smoldering-stump', height: 0.6 },
    { id: 'gen3d-magma-crystal', height: 0.9 },
    { id: 'gen3d-scree-rock-pile', height: 0.6 },
  ],
  mid: [
    { id: 'gen3d-burnt-tree', height: 4.5 },
    { id: 'gen3d-dead-desert-tree', height: 3.5 },
    { id: 'gen3d-basalt-column-rock', height: 3 },
  ],
  far: [
    { id: 'gen3d-burnt-tree', height: 6 },
    { id: 'gen3d-basalt-column-rock', height: 4.5 },
  ],
  leaf: '#4a3b2e',
  density: 0.35,
  fill: true,
};

/** Jeskyně: stalagmity, skalní sloupy, krystaly a houby. */
export const CAVE_FILL: Flora = {
  near: [
    { id: 'gen3d-cave-crystal-cluster', height: 0.9 },
    { id: 'gen3d-mushroom-cluster', height: 0.5 },
    { id: 'mushroom', height: 0.6 },
    { id: 'gen3d-scree-rock-pile', height: 0.6 },
    { id: 'gen3d-energy-crystal', height: 0.9 },
  ],
  mid: [
    { id: 'gen3d-stalagmite', height: 3 },
    { id: 'gen3d-stalagmite', height: 3 },
    { id: 'gen3d-rock-pillar', height: 4 },
    { id: 'gen3d-power-crystal', height: 1.8 },
  ],
  far: [
    { id: 'gen3d-stalagmite', height: 4 },
    { id: 'gen3d-rock-pillar', height: 5 },
  ],
  leaf: '#5a6b4a',
  density: 0.4,
  fill: true,
};

/** Pod vodou: korály, sasanky, houby, chaluhy a kameny útesu. */
export const UNDERWATER_FILL: Flora = {
  near: [
    { id: 'gen3d-coral', height: 0.9 },
    { id: 'gen3d-sea-anemone', height: 0.6 },
    { id: 'gen3d-sea-sponge', height: 0.7 },
    { id: 'gen3d-coral-rock', height: 0.9 },
    { id: 'gen3d-seaweed', height: 1.2 },
    { id: 'gen3d-sea-rock', height: 0.8 },
  ],
  mid: [
    { id: 'gen3d-seaweed', height: 2.6 },
    { id: 'gen3d-coral', height: 1.8 },
    { id: 'gen3d-rock-arch', height: 2.5 },
    { id: 'gen3d-sea-rock', height: 1.6 },
  ],
  far: [
    { id: 'gen3d-seaweed', height: 3 },
    { id: 'gen3d-rock-pillar', height: 4 },
  ],
  leaf: '#2f7a5a',
  density: 0.45,
  fill: true,
};

/** Moře: skaliska, balvany s mušlemi, chaluhy na hladině a skalní věže v dálce. */
export const OCEAN_FILL: Flora = {
  near: [
    { id: 'gen3d-sea-rock', height: 0.8 },
    { id: 'gen3d-barnacle-rock', height: 0.8 },
    { id: 'gen3d-river-boulder', height: 0.8 },
    { id: 'gen3d-seaweed', height: 0.8 },
  ],
  mid: [
    { id: 'gen3d-rock-pillar', height: 4.5 },
    { id: 'gen3d-rock-arch', height: 3.5 },
    { id: 'gen3d-basalt-column-rock', height: 3.5 },
  ],
  far: [
    { id: 'gen3d-rock-pillar', height: 6 },
    { id: 'gen3d-basalt-column-rock', height: 5 },
  ],
  leaf: '#3f7a4a',
  density: 0.3,
  fill: true,
};

/*
 * Interiéry: rostliny v květináčích, krabice a sudy. Bez linie v dálce – za regály a nábytkem je stěna mlhy.
 */

export const SUPERMARKET_FILL: Flora = {
  near: [
    { id: 'gen3d-cardboard-box', height: 0.8 },
    { id: 'gen3d-fruit-crate', height: 0.6 },
    { id: 'gen3d-bread-basket', height: 0.5 },
    { id: 'gen3d-potato-sack', height: 0.8 },
    { id: 'gen3d-vegetable-basket', height: 0.6 },
    { id: 'gen3d-flour-sack', height: 0.8 },
  ],
  mid: [
    { id: 'potted-plant', height: 1.8 },
    { id: 'gen3d-monstera-plant', height: 1.6 },
    { id: 'gen3d-wine-barrel', height: 1.2 },
  ],
  far: [],
  leaf: '#4f8a3a',
  density: 0.25,
  fill: true,
};

export const MALL_FILL: Flora = {
  near: [
    { id: 'gen3d-flower-pot', height: 0.6 },
    { id: 'gen3d-planter-box', height: 0.8 },
    { id: 'gen3d-shopping-bag', height: 0.5 },
    { id: 'gen3d-gift-box', height: 0.5 },
    { id: 'gen3d-cardboard-box', height: 0.7 },
    { id: 'gen3d-street-trash-can', height: 1 },
  ],
  mid: [
    { id: 'gen3d-monstera-plant', height: 1.6 },
    { id: 'gen3d-concrete-planter-with-tree', height: 3.2 },
    { id: 'gen3d-aloe-plant', height: 1.1 },
  ],
  far: [],
  leaf: '#4f8a3a',
  density: 0.25,
  fill: true,
};

export const LIVING_ROOM_FILL: Flora = {
  near: [
    { id: 'gen3d-flower-pot', height: 0.5 },
    { id: 'gen3d-clay-pot', height: 0.6 },
    { id: 'gen3d-cardboard-box', height: 0.7 },
    { id: 'gen3d-gift-box', height: 0.5 },
    { id: 'gen3d-agave-plant', height: 0.9 },
  ],
  mid: [
    { id: 'potted-plant', height: 1.6 },
    { id: 'gen3d-monstera-plant', height: 1.6 },
    { id: 'gen3d-cat-tree', height: 1.6 },
    { id: 'gen3d-aloe-plant', height: 1.1 },
  ],
  far: [],
  leaf: '#4f8a3a',
  density: 0.25,
  fill: true,
};

export const FACTORY_FILL: Flora = {
  near: [
    { id: 'gen3d-cardboard-box', height: 0.8 },
    { id: 'gen3d-oil-drum', height: 1 },
    { id: 'gen3d-toxic-barrel', height: 1 },
    { id: 'gen3d-tire-pile', height: 0.8 },
    { id: 'gen3d-toolbox', height: 0.4 },
    { id: 'gen3d-traffic-cone', height: 0.6 },
  ],
  mid: [
    { id: 'gen3d-oil-barrel', height: 1.2 },
    { id: 'potted-plant', height: 1.6 },
    { id: 'gen3d-rooftop-water-tank', height: 3 },
  ],
  far: [],
  leaf: '#4f8a3a',
  density: 0.25,
  fill: true,
};
