/**
 * Zem pod panoramatem (živé měření P29, 26. 9. 2026).
 *
 * Obsah panoramatu – stůl, jeskyně, krátery – leží v jeho dolní půlce, tedy na
 * podlaze pod hráčem. Neprůhledná zem sady ho celou zakryla: soudce viděl jen
 * oblohu a vlastní panorama bylo k ničemu. Vnější zem se proto kreslí první a
 * bez zápisu hloubky; panorama (`renderOrder` −1) ji pak přemaluje svou
 * podlahou. Dokud se panorama nenačte, zůstává vidět barva sady jako dřív.
 *
 * Jen pro zem, která je kulisou – ne pro herní plochy (dráha, láva pod
 * plošinami, podlaha arény): ty musí zůstat nad panoramatem.
 */

export const UNDER_PANORAMA = -2;
