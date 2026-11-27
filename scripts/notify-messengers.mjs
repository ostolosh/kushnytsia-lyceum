// Надсилає нові новини (з Facebook, зі старого сайту та написані в адмін-панелі) у Telegram-канал і, за наявності доступу, у Viber-канал.
// Пам'ятає вже надіслане в data/notified.json, тому не дублює повідомлення.
// Перший запуск лише запам'ятовує наявні новини й нічого не надсилає.
//
// Змінні середовища (усі необов'язкові, без них відповідний месенджер пропускається):
//   SITE_URL            адреса сайту, наприклад https://kushnytsia-lyceum.github.io/site
//   TELEGRAM_BOT_TOKEN  токен бота від @BotFather
//   TELEGRAM_CHAT_ID    @назва_каналу або числовий id
//   VIBER_AUTH_TOKEN, VIBER_FROM   Viber (не перевірено, див. README)

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
// адреса сайту: змінна SITE_URL або, якщо її немає, адреса GitHub Pages цього репозиторію
const repo = process.env.GITHUB_REPOSITORY || "";
const SITE = (process.env.SITE_URL || (repo ? `https://${repo.split("/")[0].toLowerCase()}.github.io/${repo.split("/")[1]}` : "")).replace(/\/$/, "");
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN, TG_CHAT = process.env.TELEGRAM_CHAT_ID;
const VB_TOKEN = (process.env.VIBER_AUTH_TOKEN || "").trim();
let VB_FROM = (process.env.VIBER_FROM || "").trim(); // необов'язково: інакше береться суперадмін каналу
// Viber вимагає один раз зареєструвати вебхук: будь-яку https-адресу, що відповідає 200 (напр. Cloudflare Worker «Hello World»)
const VB_HOOK = (process.env.VIBER_WEBHOOK_URL || "").trim();

const readJSON = async (f, d) => (existsSync(path.join(root, f)) ? JSON.parse(await readFile(path.join(root, f), "utf8")) : d);

// той самий алгоритм, що й на сайті: id ручної новини з дати й заголовка
function hash(s) { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h.toString(36); }

const fb = (await readJSON("posts.json", { posts: [] })).posts || [];
const manual = ((await readJSON("posts-manual.json", { posts: [] })).posts || []).filter((m) => m && m.title);
const archive = (await readJSON("news-archive.json", { posts: [] })).posts || [];
// новина зі старого сайту, яка повторює допис із Facebook (той самий день і заголовок), не надсилається вдруге
const key = (d, t) => String(d || "").slice(0, 10) + "|" + String(t || "").toLowerCase().replace(/[^0-9a-zа-яіїєґ]+/g, "").slice(0, 24);
const fbKeys = new Set(fb.map((p) => key(p.date, String(p.text || "").trim().split(/\n+/)[0])));

const all = [
  ...fb.filter((p) => !p.legacy && !p.sample).map((p) => {
    const lines = String(p.text || "").trim().split(/\n+/);
    return { id: "fb:" + p.id, date: p.date, title: lines.shift() || "Публікація", body: lines.join("\n"), image: p.image, link: p.url || SITE };
  }),
  ...manual.map((m) => {
    const id = "m" + hash((m.date || "") + "|" + m.title);
    return { id: "man:" + id, date: m.date, title: m.title, body: (m.text || "").trim(), image: m.image || (m.gallery && m.gallery[0]) || "", link: SITE ? `${SITE}/#post-${id}` : "" };
  }),
  ...archive.filter((a) => a && a.title && !fbKeys.has(key(a.date, a.title))).map((a) => (
    { id: "old:" + a.id, date: a.date, title: a.title, body: String(a.text || "").trim(), image: (a.images || [])[0] || "", link: SITE ? `${SITE}/#post-${a.id}` : "" })),
];

const notifiedPath = path.join(root, "data", "notified.json");
await mkdir(path.dirname(notifiedPath), { recursive: true });
let notified = existsSync(notifiedPath) ? JSON.parse(await readFile(notifiedPath, "utf8")) : null;
if (!notified) {
  await writeFile(notifiedPath, JSON.stringify({ ids: all.map((p) => p.id) }, null, 1) + "\n");
  console.log(`Перший запуск: запам'ятовано ${all.length} наявних новин, нічого не надіслано.`);
  process.exit(0);
}
const done = new Set(notified.ids);
// надсилаємо лише свіжі новини: старі (наприклад, перше завантаження історії з Facebook) тільки позначаємо як опрацьовані
const MAX_AGE_MS = Number(process.env.NOTIFY_MAX_AGE_DAYS || 3) * 86400000;
const unseen = all.filter((p) => !done.has(p.id));
const fresh = unseen.filter((p) => Date.now() - new Date(p.date) <= MAX_AGE_MS).sort((a, b) => new Date(a.date) - new Date(b.date));
unseen.filter((p) => !fresh.includes(p)).forEach((p) => done.add(p.id));
if (!fresh.length && process.env.VIBER_TEST !== "true") { await writeFile(notifiedPath, JSON.stringify({ ids: [...done] }, null, 1) + "\n"); console.log("Нових свіжих новин немає."); process.exit(0); }
if (!TG_TOKEN && !VB_TOKEN) console.log("Жоден месенджер не налаштовано; новини лише позначаються як опрацьовані.");

const abs = (u) => (!u ? "" : /^https?:/.test(u) ? u : SITE ? `${SITE}/${u.replace(/^\//, "")}` : "");
const short = (t, n) => (t.length > n ? t.slice(0, n).replace(/\s+\S*$/, "") + "…" : t);

async function telegram(p) {
  const text = [p.title, p.body ? "\n" + short(p.body, 700) : "", p.link ? "\nЧитати: " + p.link : ""].filter(Boolean).join("\n").trim();
  const call = (method, body) => fetch(`https://api.telegram.org/bot${TG_TOKEN}/${method}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
  let res = null;
  if (p.image && text.length <= 1024) {
    const local = !/^https?:/.test(p.image) && path.join(root, p.image.replace(/^\//, ""));
    if (local && existsSync(local)) {
      // фото з репозиторію надсилаємо файлом: на сайті воно з'являється лише після збирання
      const form = new FormData();
      form.append("chat_id", TG_CHAT);
      form.append("caption", text);
      form.append("photo", new Blob([await readFile(local)]), path.basename(local));
      res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendPhoto`, { method: "POST", body: form }).then((r) => r.json());
    } else if (abs(p.image)) res = await call("sendPhoto", { chat_id: TG_CHAT, photo: abs(p.image), caption: text });
    if (res && !res.ok) console.log("Фото не надіслано (" + res.description + "), надсилаю текст.");
  }
  if (!res || !res.ok) res = await call("sendMessage", { chat_id: TG_CHAT, text: text.slice(0, 4096), disable_web_page_preview: false });
  if (!res.ok) throw new Error("Telegram: " + res.description);
}

// Viber: публікація в канал через Channels Post API (маркер з «Інструментів розробника» каналу).
// Помилка тут не зупиняє роботу: вона лише виводиться в журнал.
// хто публікує в канал: ID суперадміністратора. Якщо VIBER_FROM не задано, беремо його з даних каналу.
// ID у журнал не виводимо: журнали публічного репозиторію видно всім.
async function viberSender() {
  const info = await fetch("https://chatapi.viber.com/pa/get_account_info", {
    method: "POST", headers: { "Content-Type": "application/json", "X-Viber-Auth-Token": VB_TOKEN }, body: "{}",
  }).then((r) => r.json());
  if (info.status !== 0) throw new Error("Viber: маркер не прийнято (" + (info.status_message || info.status) + "). Перевірте секрет VIBER_AUTH_TOKEN.");
  console.log(`Viber: канал «${info.name || "?"}».`);
  const admins = (info.members || []).filter((m) => m.role === "superadmin");
  const me = admins.find((m) => m.id === VB_FROM) || admins[0];
  if (!me) throw new Error("Viber: у каналі не знайдено суперадміністратора, від імені якого публікувати.");
  console.log(`Viber: публікую від імені суперадміністратора «${me.name}».`);
  return me.id;
}

// Viber бере фото лише за публічним посиланням. Свіжих фото на сайті ще немає (сайт збирається пізніше),
// тому беремо оригінал із Facebook чи старого сайту, який записала синхронізація в .remote-images.json.
const remoteImages = existsSync(path.join(root, ".remote-images.json")) ? JSON.parse(await readFile(path.join(root, ".remote-images.json"), "utf8")) : {};

async function viber(p) {
  const api = (method, body) => fetch("https://chatapi.viber.com/pa/" + method, {
    method: "POST", headers: { "Content-Type": "application/json", "X-Viber-Auth-Token": VB_TOKEN },
    body: JSON.stringify(body),
  }).then((r) => r.json());
  const post = async (body) => {
    let res = await api("post", { from: VB_FROM, ...body });
    if (res.status === 10) { // webhookNotSet
      if (!VB_HOOK) throw new Error("Viber: для каналу не зареєстровано вебхук. Додайте змінну VIBER_WEBHOOK_URL (див. README, «Новини в Telegram і Viber»).");
      const hook = await api("set_webhook", { url: VB_HOOK, event_types: ["failed"], send_name: false, send_photo: false });
      if (hook.status !== 0) throw new Error("Viber: не вдалося зареєструвати вебхук (" + (hook.status_message || hook.status) + "). Перевірте, що адреса VIBER_WEBHOOK_URL відкривається й відповідає 200.");
      console.log("Viber: вебхук зареєстровано.");
      res = await api("post", { from: VB_FROM, ...body });
    }
    return res;
  };
  const make = (n) => [p.title, p.body ? "\n" + short(p.body, n) : "", p.link ? "\n" + p.link : ""].filter(Boolean).join("\n").trim();
  // фото: оригінал зі щойно виконаної синхронізації або фото, що вже є на сайті (новини з адмін-панелі)
  const media = remoteImages[p.id] || abs(p.image);
  if (media) {
    // у підписі до фото Viber дозволяє до 768 символів
    let text = make(500);
    if (text.length > 768) text = text.slice(0, 767) + "…";
    const res = await post({ type: "picture", text, media, thumbnail: media });
    if (res.status === 0) return;
    console.log("Viber: фото не прийнято (" + (res.status_message || res.status) + "), надсилаю текст.");
  }
  const res = await post({ type: "text", text: make(800) });
  if (res.status !== 0) throw new Error("Viber: " + JSON.stringify(res));
}

// Тест Viber (кнопка Run workflow з позначкою): лише остання новина, лише у Viber, список надісланого не змінюється
if (process.env.VIBER_TEST === "true") {
  if (!VB_TOKEN) { console.error("Viber: секрет VIBER_AUTH_TOKEN не задано."); process.exit(1); }
  const last = [...all].sort((a, b) => new Date(b.date) - new Date(a.date))[0];
  try { VB_FROM = await viberSender(); await viber(last); console.log("Viber ✓ (тест)", last.title); }
  catch (e) { console.error(e.message); process.exit(1); }
  process.exit(0);
}

if (VB_TOKEN) { try { VB_FROM = await viberSender(); } catch (e) { console.error(e.message); VB_FROM = ""; process.exitCode = 1; } }

for (const p of fresh) {
  let sentAny = false;
  if (TG_TOKEN && TG_CHAT) { try { await telegram(p); sentAny = true; console.log("Telegram ✓", p.title); } catch (e) { console.error(e.message); process.exitCode = 1; continue; } }
  if (VB_TOKEN && VB_FROM) { try { await viber(p); console.log("Viber ✓", p.title); } catch (e) { console.error(e.message); process.exitCode = 1; } }
  done.add(p.id);
}
await writeFile(notifiedPath, JSON.stringify({ ids: [...done] }, null, 1) + "\n");
