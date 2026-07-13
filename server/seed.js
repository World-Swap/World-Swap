// server/seed.js — populate demo listings for trials. Run once: npm run seed
import { q } from './config.js';
import { sealSecret } from './crypto.js';

const rnd = () => '0x' + Array.from({length:40},()=>'0123456789abcdef'[Math.floor(Math.random()*16)]).join('');

const L = [
  {kind:'digital',category:'Digital',title:'Lightroom preset pack — 40 cinematic presets',desc:'Warm, filmic presets for Lightroom Classic & mobile. Instant download.',price:18,handle:'tonecraft',asset:{asset_type:'link',value:'https://worldswap.app/dl/presets-demo'}},
  {kind:'digital',category:'Digital',title:'Indie strategy game — Steam key',desc:'Region-free retail Steam key, activates worldwide. Instant delivery.',price:24.5,handle:'keyvault',asset:{asset_type:'key',value:'STEAM-8F3K-Q2LM-77XZ-DEMO'}},
  {kind:'physical',category:'Electronics',title:'Vintage film camera — Canon AE-1',desc:'Serviced 35mm SLR with 50mm f/1.8 lens. Ships worldwide, tracked.',price:210,handle:'analoglab',days:5},
  {kind:'physical',category:'Fashion',title:'Handmade leather messenger bag',desc:'Full-grain leather, brass hardware, made to order.',price:165,handle:'stitchandhide',days:14},
  {kind:'service',category:'Web Development',title:'I will build your React + Node web app',desc:'Full-stack build: responsive front end, REST API, Postgres, deployed. Escrow released on approval.',price:900,handle:'pixelforge',days:14},
  {kind:'service',category:'Design',title:'Logo & brand identity kit',desc:'Custom logo, color system, type pairing, mini brand sheet. 3 concepts, 2 revisions.',price:280,handle:'markmaker',days:6},
  {kind:'service',category:'Writing',title:'SEO blog writing — 4 articles',desc:'Four 1,200-word researched, keyword-optimized articles as Google Docs.',price:160,handle:'inkwell',days:5},
];

for (const l of L) {
  const seller = rnd();
  const { rows } = await q(
    `INSERT INTO listings (seller_wallet, handle, kind, category, title, description, price_usdc, delivery_days)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [seller, l.handle, l.kind, l.category, l.title, l.desc, l.price, l.kind==='digital'?null:l.days]);
  if (l.kind === 'digital') {
    const { ciphertext } = await sealSecret(l.asset);
    await q(`INSERT INTO digital_assets (listing_id, asset_type, secret_ciphertext) VALUES ($1,$2,$3)`,
      [rows[0].id, l.asset.asset_type, ciphertext]);
  }
}
console.log(`seeded ${L.length} listings`);
process.exit(0);
