// Синхронізація публікацій зі сторінки Facebook у posts.json.
// Запуск: FB_PAGE_ID=... FB_PAGE_TOKEN=... node scripts/sync-facebook.mjs
// Потрібен Node.js 20+ (вбудований fetch). Залежностей немає.
//
// Необов'язкові змінні:
//   FB_API_VERSION  версія Graph API, напр. v23.0 (без неї береться версія за замовчуванням застосунку)
//   FB_LIMIT        скільки публікацій на сторінку запиту (25)
//   FB_PAGES        скільки сторінок запиту гортати за один запуск (2; для першого заповнення можна 20)
//   FB_KEEP         скільки публікацій зберігати в posts.json (500)
//   FB_PHOTOS       скільки фото зберігати з однієї публікації (1: головне фото; решта дивляться у Facebook)

import { readFile, writeFile, mkdir, readdir, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const PAGE_ID = (process.env.FB_PAGE_ID || "").trim();
const TOKEN = (process.env.FB_PAGE_TOKEN || "").trim();
const VERSION = (process.env.FB_API_VERSION || "").trim();
const LIMIT = Number(process.env.FB_LIMIT || 25);
const PAGES = Number(process.env.FB_PAGES || 2);
const KEEP = Number(process.env.FB_KEEP || 500);
const PHOTOS = Math.max(1, Number(process.env.FB_PHOTOS || 1));

if (!PAGE_ID || !TOKEN) {
  // Без ключів просто пропускаємо, щоб щоденний запуск не «падав», доки їх не додано.
  console.log("FB_PAGE_ID або FB_PAGE_TOKEN не задано: синхронізацію пропущено. Див. README, розділ «Підключення Facebook».");
  process.exit(0);
}

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const postsFile = path.join(root, "posts.json");
const imagesDir = path.join(root, "images");
const base = (process.env.FB_GRAPH_URL || "https://graph.facebook.com/") + (VERSION ? VERSION + "/" : "");

async function graph(url) {
  const res = await fetch(url);
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) {
    const e = json.error || {};
    let hint = "";
    if (e.code === 190) hint = " Токен недійсний або прострочений: створіть новий (README, «Підключення Facebook»).";
    else if (e.code === 10 || e.code === 200) hint = " Бракує дозволу pages_read_engagement або токен не від цієї сторінки.";
    else if (e.code === 100) hint = " Перевірте FB_PAGE_ID.";
    throw new Error("Graph API: " + (e.message || res.status) + hint);
  }
  return json;
}

async function download(url, name) {
  try {
    const res = await fetch(url);
    if (!res.ok) return "";
    const type = res.headers.get("content-type") || "";
    const ext = type.includes("png") ? "png" : type.includes("webp") ? "webp" : "jpg";
    const file = `${name}.${ext}`;
    await writeFile(path.join(imagesDir, file), Buffer.from(await res.arrayBuffer()));
    return `images/${file}`;
  } catch {
    return "";
  }
}

// усі фото публікації: альбом (subattachments) або одне фото
function photoUrls(p) {
  const out = [];
  const add = (m) => { const src = m?.image?.src; if (src && !out.includes(src)) out.push(src); };
  for (const a of p.attachments?.data || []) {
    if (a.subattachments?.data?.length) a.subattachments.data.forEach((s) => add(s.media));
    else add(a.media);
  }
  if (!out.length && p.full_picture) out.push(p.full_picture);
  return out;
}

function textOf(p) {
  const t = (p.message || "").trim();
  if (t) return t;
  const a = p.attachments?.data?.[0];
  return [a?.title, a?.description].filter(Boolean).join("\n").trim();
}

async function main() {
  await mkdir(imagesDir, { recursive: true });

  let existing = { posts: [] };
  if (existsSync(postsFile)) {
    try { existing = JSON.parse(await readFile(postsFile, "utf8")); } catch {}
  }
  // приклади й записи старого сайту прибираємо: старий сайт тепер в news-archive.json
  const known = new Map(
    (existing.posts || []).filter((p) => !p.sample && !p.legacy).map((p) => [p.id, p])
  );

  const fields = "id,message,created_time,permalink_url,full_picture,status_type," +
    "attachments{media_type,title,description,media,url,subattachments.limit(20){media_type,media}}";
  // ---- діагностика токена (самі токени ніколи не виводяться)
  let token = TOKEN, pageId = PAGE_ID;
  const me = await graph(`${base}me?metadata=1&fields=id,name,metadata{type}&access_token=${encodeURIComponent(token)}`);
  const meType = me.metadata?.type || "";
  if (meType === "page") {
    console.log(`Токен належить сторінці «${me.name}» — добре.`);
    if (me.id !== PAGE_ID) { console.log(`Увага: FB_PAGE_ID не збігається з ID цієї сторінки (${me.id}). Використовую ${me.id}.`); pageId = me.id; }
  } else {
    console.log(`Увага: токен належить не сторінці, а користувачу «${me.name}» (id ${me.id}).` + (me.id === PAGE_ID ? " У FB_PAGE_ID записано ID цього користувача, а не сторінки." : ""));
    // сторінки, до яких цей користувач має доступ
    let pages = [];
    try { pages = (await graph(`${base}me/accounts?fields=id,name,access_token&limit=100&access_token=${encodeURIComponent(token)}`)).data || []; }
    catch (e) { console.log("Не вдалося отримати список сторінок: " + e.message); }
    console.log(pages.length ? "Доступні сторінки: " + pages.map((p) => `«${p.name}» (ID ${p.id})`).join(", ") : "Цей користувач не має доступу до жодної сторінки: призначте йому сторінку в бізнес-налаштуваннях.");
    const pick = pages.find((p) => p.id === PAGE_ID) || (pages.length === 1 ? pages[0] : pages.find((p) => /кушниц/i.test(p.name)));
    if (pick && pick.access_token) {
      token = pick.access_token; pageId = pick.id;
      console.log(`Використовую сторінку «${pick.name}» (ID ${pick.id}). Порада: запишіть цей ID у FB_PAGE_ID.`);
    }
  }

  // ---- дописи: posts, а якщо там порожньо — published_posts і feed
  const data = [];
  for (const edge of ["posts", "published_posts", "feed"]) {
    let url = `${base}${encodeURIComponent(pageId)}/${edge}?fields=${encodeURIComponent(fields)}&limit=${LIMIT}&access_token=${encodeURIComponent(token)}`;
    const got = [];
    try {
      for (let i = 0; i < PAGES && url; i++) {
        const page = await graph(url);
        got.push(...(page.data || []));
        url = page.paging?.next || "";
      }
    } catch (e) { console.log(`${edge}: помилка — ${e.message}`); continue; }
    console.log(`${edge}: отримано ${got.length} дописів` + (got[0] ? ` (останній ${got[0].created_time}, тип ${got[0].status_type || "—"})` : ""));
    if (got.length) { data.push(...got); break; }
  }
  if (!data.length) console.log("Facebook не повернув жодного допису. Якщо на сторінці дописи є, перевірте, що застосунок у режимі Live, а токен — від сторінки (див. README).");

  let added = 0, updated = 0, skipped = 0;
  for (const p of data) {
    const text = textOf(p);
    const all = photoUrls(p), urls = all.slice(0, PHOTOS);
    if (!text && !urls.length) { skipped++; continue; } // порожні службові події пропускаємо
    const prev = known.get(p.id);
    const safeId = p.id.replace(/[^\w-]/g, "_");
    // фото тягнемо лише раз: посилання Facebook CDN з часом протухають
    let gallery = prev?.gallery || (prev?.image ? [prev.image] : []);
    if (!gallery.length && urls.length) {
      gallery = [];
      for (let k = 0; k < urls.length; k++) {
        const f = await download(urls[k], k ? `${safeId}-${k + 1}` : safeId);
        if (f) gallery.push(f);
      }
    }
    const video = (p.attachments?.data || []).some((a) => /video/.test(a.media_type || "")) || /video/.test(p.status_type || "");
    const item = { id: p.id, date: p.created_time, text, image: gallery[0] || "", gallery, url: p.permalink_url || "" };
    if (video) item.video = true;
    if (all.length > gallery.length) item.morePhotos = all.length; // решта фото лише у Facebook
    if (!prev) added++;
    else if (prev.text !== text) updated++;
    known.set(p.id, item);
  }

  const posts = [...known.values()]
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .slice(0, KEEP);

  const out = {
    updated: new Date().toISOString(),
    source: "facebook",
    pageUrl: `https://www.facebook.com/${pageId}`,
    posts,
  };
  await writeFile(postsFile, JSON.stringify(out, null, 2) + "\n");

  // прибираємо фото публікацій, які вже випали зі списку або більше не використовуються
  const used = new Set(posts.flatMap((q) => (q.gallery || [q.image]).filter(Boolean).map((f) => path.basename(f))));
  let removed = 0;
  for (const f of await readdir(imagesDir)) {
    if (!used.has(f) && /\.(jpe?g|png|webp)$/i.test(f)) { await unlink(path.join(imagesDir, f)); removed++; }
  }
  if (removed) console.log(`Видалено фото, які більше не потрібні: ${removed}.`);
  console.log(`Готово: ${posts.length} публікацій, нових: ${added}, змінених: ${updated}` + (skipped ? `, пропущено без тексту й фото: ${skipped}` : "") + ".");
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
