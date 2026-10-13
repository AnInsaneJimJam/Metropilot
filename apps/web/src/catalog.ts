import { marketCatalog } from '@monad-hack/connectors/registry';
import { priceUnitKey, OUTPUT_SCHEMAS } from '@monad-hack/strategy';
import type { Catalog } from '@monad-hack/strategy';
// The single adapter from catalog records to editor dropdowns. Paper catalog only until G3 serves a live one.
export const editorCatalog: Catalog = marketCatalog;
export type Option = [string, string];
const VENUE_LABEL: Record<string, string> = { 'uniswap-v3': 'Uniswap v3', kuru: 'Kuru', curve: 'Curve StableSwap-NG', aave: 'Aave v3' };
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
  return orNone(Object.entries(editorCatalog.feeds).map(([ref, f]) => [`${assetSymbol(f.baseAssetRef)}/${f.quoteUnit} · ${venueLabel(f.connectorRef)} ${f.source === 'nativeOracle' ? 'native USD oracle' : `${f.windowSeconds}s ${f.source === 'poolEma' ? 'native EMA parameter' : 'geometric TWAP'}`}`, ref]));
}
/** Distinct base/quote pairs that some feed quotes, for Price literals. */
export function priceUnitOptions(): Option[] {
  const seen = new Map<string, string>();
  for (const f of Object.values(editorCatalog.feeds)) seen.set(priceUnitKey(f.baseAssetRef, f.quoteUnit), `${f.quoteUnit} per ${assetSymbol(f.baseAssetRef)}`);
  return orNone([...seen].map(([key, label]) => [label, key]));
}
/** Read operations some connector allows, and the connectors that offer reads. */
export function readOperationOptions(): Option[] {
  const operations = new Set(Object.values(editorCatalog.reads).flatMap(r => Object.keys(r)));
  return orNone([...operations].map(op => [op === 'price.read' ? 'native protocol price' : op === 'ausd.price.read' ? 'AUSD native USD price' : op === 'reserve.read' ? 'USDC reserve APRs' : op === 'ausd.reserve.read' ? 'AUSD reserve APRs' : op, op]));
}
export function readConnectorOptions(): Option[] {
  return orNone(Object.keys(editorCatalog.reads).filter(ref => Object.hasOwn(editorCatalog.connectors, ref)).map(ref => [venueLabel(ref), ref]));
}
export function modelOptions(): Option[] {
  return orNone(Object.entries(editorCatalog.modelProfiles).map(([ref, m]) => [`${m.modelId}${m.provider === 'synthetic' ? ' (synthetic)' : ''}`, ref]));
}
/** Every field a read result or AI output schema can bind, for the field block. */
export function recordFieldOptions(): Option[] {
  const fields = new Set([...Object.values(editorCatalog.reads).flatMap(r => Object.values(r).flatMap(spec => Object.keys(spec.result))), ...Object.values(OUTPUT_SCHEMAS).flatMap(Object.keys)]);
  return orNone([...fields].map(f => [f, f]));
}
export function feedQuoteLabel(feedRef: string): string {
  const feed = Object.hasOwn(editorCatalog.feeds, feedRef) ? editorCatalog.feeds[feedRef] : undefined;
  return feed ? `${feed.quoteUnit} per ${assetSymbol(feed.baseAssetRef)}` : '';
}
