/* 品牌 / 造景 / 主鱼皮肤 / 独立功能 / PRO 全解锁价格的唯一数据源（Electron 主进程与中心服务端共用，前端见 src/catalog.js） */
const catalog = require('./catalog.json');

const yuan = (cents) => (cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2));
const freeThemes = catalog.themes.filter((t) => t.cents === 0).map((t) => t.id);
const paidThemes = catalog.themes.filter((t) => t.cents > 0);
const skins = Array.isArray(catalog.skins) ? catalog.skins : [];
const freeSkins = skins.filter((s) => s.cents === 0).map((s) => s.id);
const paidSkins = skins.filter((s) => s.cents > 0);
const features = Array.isArray(catalog.features) ? catalog.features : [];

const totalSeparateCents =
  paidThemes.reduce((sum, t) => sum + t.cents, 0) +
  paidSkins.reduce((sum, s) => sum + s.cents, 0) +
  features.reduce((sum, f) => sum + f.cents, 0);
const bundleSaving = Math.max(0, totalSeparateCents - catalog.bundle.cents);

/* 可售商品：PRO 终身全解锁 + 付费造景单品 + 付费主鱼皮肤单品 + 独立功能（如巨幕屏保） */
const skus = Object.fromEntries([
  [catalog.bundle.id, {
    ...catalog.bundle,
    themes: catalog.bundle.themes || paidThemes.map((t) => t.id),
    skins: catalog.bundle.skins || paidSkins.map((s) => s.id),
    features: catalog.bundle.features || features.map((f) => f.id)
  }],
  ...paidThemes.map((t) => [t.id, { id: t.id, kind: 'theme', name: `${t.name}（造景）`, cents: t.cents, themes: [t.id], skins: [], features: [] }]),
  ...paidSkins.map((s) => [s.id, { id: s.id, kind: 'skin', name: `${s.name}（鱼皮）`, cents: s.cents, themes: [], skins: [s.id], features: [] }]),
  ...features.map((f) => [f.id, { id: f.id, kind: 'feature', name: f.name, cents: f.cents, themes: [], skins: [], features: [f.id] }])
]);

const appleSkuPrefix = catalog.brand?.appleSkuPrefix || 'com.deskoasis.app.sku.';
const appleProductId = (skuId) => `${appleSkuPrefix}${String(skuId || '').replace(/-/g, '_')}`;
const skuFromAppleProduct = (productId) => {
  const s = String(productId || '').trim();
  if (!s.startsWith(appleSkuPrefix)) return null;
  const id = s.slice(appleSkuPrefix.length);
  return skus[id] || skus[id.replace(/_/g, '-')] || null;
};

module.exports = { ...catalog, skins, features, skus, yuan, freeThemes, paidThemes, freeSkins, paidSkins, bundleSaving, appleProductId, skuFromAppleProduct };
