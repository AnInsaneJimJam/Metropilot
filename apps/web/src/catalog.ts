import { syntheticCatalog, priceUnitKey } from '@monad-hack/strategy';
import type { Catalog } from '@monad-hack/strategy';
// The single adapter from catalog records to editor dropdowns. Paper catalog only until G3 serves a live one.
export const editorCatalog: Catalog = syntheticCatalog;
export type Option = [string, string];
const VENUE_LABEL: Record<string, string> = { 'uniswap-v3': 'Uniswap v3', kuru: 'Kuru' };
const orNone = (options: Option[]): Option[] => options.length ? options : [['(none in catalog)', '']];

export const assetSymbol = (ref: string): string => ref.slice(ref.lastIndexOf('.') + 1);
export const asset = (ref: string) => Object.hasOwn(editorCatalog.assets, ref) ? editorCatalog.assets[ref] : undefined;
export const venueLabel = (connectorRef: string): string => {
  const connector = Object.hasOwn(editorCatalog.connectors, connectorRef) ? editorCatalog.connectors[connectorRef] : undefined;
  return connector ? VENUE_LABEL[connector.venue] ?? connector.venue : connectorRef;
};

export function assetOptions(): Option[] {
  return orNone(Object.entries(editorCatalog.assets).map(([ref, a]) => [a.native ? `${assetSymbol(ref)} (native)` : assetSymbol(ref), ref]));
}
export function connectorOptions(action: string): Option[] {
  return orNone(Object.entries(editorCatalog.connectors).filter(([, c]) => c.actions.includes(action)).map(([ref]) => [venueLabel(ref), ref]));
}
export function feedOptions(): Option[] {
  return orNone(Object.entries(editorCatalog.feeds).map(([ref, f]) => [`${assetSymbol(f.baseAssetRef)}/${f.quoteUnit} · ${venueLabel(f.connectorRef)} ${f.windowSeconds}s TWAP`, ref]));
}
/** Distinct base/quote pairs that some feed quotes, for Price literals. */
export function priceUnitOptions(): Option[] {
  const seen = new Map<string, string>();
  for (const f of Object.values(editorCatalog.feeds)) seen.set(priceUnitKey(f.baseAssetRef, f.quoteUnit), `${f.quoteUnit} per ${assetSymbol(f.baseAssetRef)}`);
  return orNone([...seen].map(([key, label]) => [label, key]));
}
export function feedQuoteLabel(feedRef: string): string {
  const feed = Object.hasOwn(editorCatalog.feeds, feedRef) ? editorCatalog.feeds[feedRef] : undefined;
  return feed ? `${feed.quoteUnit} per ${assetSymbol(feed.baseAssetRef)}` : '';
}
