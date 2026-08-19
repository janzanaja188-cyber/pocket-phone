// pocket-phone/index.js — 1.2.2
// ★ Action Log stays in extension state and enters the next generation as an
// ephemeral system prompt. Main replies return a plain JSON frame that is
// consumed and removed—no HTML comments, hidden divs, or extra model request.
// ★ เลิกเดา API: ppDetect() ตรวจ runtime แล้วเลือกทางที่ใช้ได้ · PP_DIAG() ดูผล
// ★ ไม่มีอิโมจิใน UI · ไม่มีกดค้าง · ไม่มีมิเตอร์ความสัมพันธ์ · ไม่มีข้อความหายเอง
// getContext ล้วน · ไม่มี import/export · lazy + try/catch
// ⚠️ รันเดี่ยวไม่ได้ ต้องแปะครบ 4 ท่อน

const PP_VERSION = '1.4.5';
const MODULE_NAME = 'pocket-phone';

function ctx() {
 try { return SillyTavern.getContext(); } catch { return null; }
}

// ══════════════════════════════════════════════════════════
// ★ FEATURE DETECTION — ตรวจว่า ST เวอร์ชันนี้มีอะไรให้ใช้ (แทนการเดา)
// ══════════════════════════════════════════════════════════
const PP_CAP = { detected: false };
function ppDetect(force) {
 if (PP_CAP.detected && !force) return PP_CAP;
 const c = ctx();
 PP_CAP.ctx = !!c;
 PP_CAP.chat = !!(c && Array.isArray(c.chat));
 PP_CAP.genQuiet = !!(c && typeof c.generateQuietPrompt === 'function');
 PP_CAP.genRaw = !!(c && typeof c.generateRaw === 'function');
 PP_CAP.stopGen = !!(c && typeof c.stopGeneration === 'function');
 PP_CAP.setExtPrompt = !!(c && typeof c.setExtensionPrompt === 'function');
 PP_CAP.msgFormat = !!(c && typeof c.messageFormatting === 'function');
 PP_CAP.saveDebounced = !!(c && typeof c.saveChatDebounced === 'function');
 PP_CAP.saveChat = !!(c && typeof c.saveChat === 'function');
 PP_CAP.multimodal = !!(c && typeof c.getMultimodalCaption === 'function');
 PP_CAP.slash = !!(c && typeof c.executeSlashCommandsWithOptions === 'function');
 PP_CAP.captionExt = !!document.querySelector('#caption_settings, [id*="caption"], [id*="Caption"]');
 PP_CAP.localforage = !!(window.SillyTavern && SillyTavern.libs && SillyTavern.libs.localforage);
 try { PP_CAP.msgEvents = Object.keys((c && c.event_types) || {}).filter(k => /MESSAGE|GENERATION/.test(k)); }
 catch { PP_CAP.msgEvents = []; }
 PP_CAP.detected = true;
 return PP_CAP;
}

// ══════════════════════════════════════════════════════════
// ★ TOKEN COUNTER — นับโทเคนของ quiet prompt / response ล่าสุด
// ══════════════════════════════════════════════════════════
let ppTokenStats = { lastPrompt: 0, lastResponse: 0, lastTotal: 0, sessionTotal: 0, count: 0 };
async function ppCountTokens(text) {
 const c = ctx();
 try {
 if (c && typeof c.getTokenCountAsync === 'function') return await c.getTokenCountAsync(String(text || ''));
 if (typeof window.getTokenCountAsync === 'function') return await window.getTokenCountAsync(String(text || ''));
 if (c && typeof c.getTokenCount === 'function') return c.getTokenCount(String(text || ''));
 } catch {}
 return 0;
}
async function ppTrackTokens(prompt, resp) {
 try {
 const p = await ppCountTokens(prompt);
 const r = await ppCountTokens(resp);
 ppTokenStats.lastPrompt = p; ppTokenStats.lastResponse = r; ppTokenStats.lastTotal = p + r;
 ppTokenStats.sessionTotal += p + r; ppTokenStats.count++;
 } catch {}
}

// ══════════════════════════════════════════════════════════
// ★ 1.0.0 GEN LOCK — กันยิงซ้อนกับ extension อื่น (summary ฯลฯ)
// ══════════════════════════════════════════════════════════
let ppStGenBusy = false;      // ST กำลังเจนของตัวเองอยู่
let ppStGenBusySince = 0;     // mobile builds can miss GENERATION_ENDED
let ppOwnGenBusy = false;     // เราเองกำลังยิง
const ppGenQueue = [];        // คิวรอ
let ppGenQueueRunning = false;

function ppRuntimeGenerationBusy() {
 try {
  const c = ctx();
  if (c && c.streamingProcessor) return true;
 } catch {}
 try {
  const btn = document.getElementById('mes_stop');
  if (btn && btn.offsetParent !== null) return true; // ST โชว์ปุ่มหยุด = กำลังเจน
 } catch {}
 return false;
}
function ppGenAvailable() {
 if (ppOwnGenBusy) return false;
 const runtimeBusy = ppRuntimeGenerationBusy();
 if (ppStGenBusy) {
  if (!ppStGenBusySince) ppStGenBusySince = Date.now();
  // Some mobile/background providers never emit GENERATION_ENDED. Once every
  // runtime signal is idle, release the stale event flag instead of waiting 60s.
  if (!runtimeBusy && Date.now() - ppStGenBusySince >= 1800) {
   ppStGenBusy = false;
   ppStGenBusySince = 0;
  } else return false;
 }
 return !runtimeBusy;
}
function ppWaitFree(maxMs) {
 const limit = maxMs || 60000;
 const start = Date.now();
 return new Promise(resolve => {
  const tick = () => {
   if (ppGenAvailable()) return resolve(true);
   if (Date.now() - start > limit) return resolve(false);
   setTimeout(tick, 400);
  };
  tick();
 });
}
/** ยิงงานเจนแบบเข้าคิว — ทุกที่ในแอปต้องเรียกผ่านตัวนี้ */
function ppGenEnqueue(job) {
 return new Promise((resolve, reject) => {
  ppGenQueue.push({ job, resolve, reject });
  ppGenQueueDrain();
 });
}
async function ppGenQueueDrain() {
 if (ppGenQueueRunning) return;
 ppGenQueueRunning = true;
 try {
  while (ppGenQueue.length) {
   const item = ppGenQueue[0];
   const free = await ppWaitFree(60000);
   if (!free) {
    ppGenQueue.shift();
    item.reject(new Error('ST ไม่ว่าง (timeout) — ลองอีกครั้ง'));
    continue;
   }
   ppOwnGenBusy = true;
   try {
    const out = await item.job();
    ppGenQueue.shift();
    item.resolve(out);
   } catch (e) {
    ppGenQueue.shift();
    item.reject(e);
   } finally {
    ppOwnGenBusy = false;
   }
   await new Promise(r => setTimeout(r, 250)); // เว้นช่องให้ ST หายใจ
  }
 } finally {
  ppGenQueueRunning = false;
 }
}

async function ppSaveChatNow() {
 const c = ctx();
 ppDetect();
 try { if (PP_CAP.saveDebounced) { c.saveChatDebounced(); return 'debounced'; } } catch {}
 try { if (PP_CAP.saveChat) { await c.saveChat(); return 'saveChat'; } } catch {}
 try { if (typeof window.saveChatConditional === 'function') { await window.saveChatConditional(); return 'conditional'; } } catch {}
 try { if (typeof window.saveChatDebounced === 'function') { window.saveChatDebounced(); return 'globalDebounced'; } } catch {}
 console.warn('[pocket-phone] ไม่พบทางบันทึกแชท');
 return null;
}
async function ppSwitchStChat(chatName) {
 const c = ctx();
 ppDetect();
 // ทางที่น่าจะได้: slash command /chat
 try {
 if (PP_CAP.slash && chatName) {
 await c.executeSlashCommandsWithOptions(`/chat ${chatName}`, { handleExecutionErrors: true });
 return true;
 }
 } catch (e) { console.warn('[pocket-phone] switch chat via slash failed', e); }
 // fallback: ฟังก์ชัน global ที่บางเวอร์ชันมี
 try { if (typeof window.openCharacterChat === 'function') { await window.openCharacterChat(chatName); return true; } } catch {}
 ppToast('สลับแชทจากในมือถือยังไม่รองรับใน ST เวอร์ชันนี้ — สลับจาก ST ได้ตามปกติ');
 return false;
}
// ดึงรายชื่อแชท (รูท) ของตัวละครปัจจุบันจาก ST — feature-detected, ต้องเทสจริง
async function ppListStChats() {
 const c = ctx();
 try {
 let avatar = '';
 if (c && Array.isArray(c.characters) && c.characterId != null) avatar = c.characters[c.characterId]?.avatar || '';
 if (!avatar) return null;
 const headers = (c && typeof c.getRequestHeaders === 'function') ? c.getRequestHeaders()
 : (typeof window.getRequestHeaders === 'function' ? window.getRequestHeaders() : { 'Content-Type': 'application/json' });
 const res = await fetch('/api/characters/chats', {
 method: 'POST', headers, body: JSON.stringify({ avatar_url: avatar }),
 });
 if (!res.ok) return null;
 const data = await res.json();
 if (!Array.isArray(data)) return null;
 return data.map(x => String(x.file_name || x.chat_id || x.chat || '').replace(/\.jsonl$/, '')).filter(Boolean);
 } catch (e) { console.warn('[pocket-phone] list chats failed', e); return null; }
}
async function ppOpenRouteSwitcher() {
 const c = ppActiveContact;
 if (!c || c.id !== currentCharacterId()) { ppToast('สลับรูทได้เฉพาะแชทของตัวละครหลักที่ผูกกับ SillyTavern'); return; }
 islandStatus('กำลังโหลดรายการแชท…');
 const chats = await ppListStChats();
 islandCollapse();
 const cur = ppStChatId();
 if (chats && chats.length) {
 ppSheet('สลับรูท (แชทของ SillyTavern)', chats.map(name => ({
 label: name + (name === cur ? ' · กำลังใช้อยู่' : ''),
 icon: ICON.messages,
 onClick: async () => { if (name !== cur) { const ok = await ppSwitchStChat(name); if (ok) ppToast('สลับไป ' + name); } },
 })));
 } else {
 // ลิสต์ไม่ได้ → ให้พิมพ์ชื่อเอง แล้วสั่ง ST สลับ
 ppPrompt('พิมพ์ชื่อแชท (รูท) ที่จะสลับไป', cur, async v => {
 v = (v || '').trim();
 if (v && v !== cur) { const ok = await ppSwitchStChat(v); if (ok) ppToast('สลับไป ' + v); }
 }, { hint: 'ST เวอร์ชันนี้ดึงรายชื่อแชทอัตโนมัติไม่ได้ — พิมพ์ชื่อไฟล์แชทที่ต้องการเอง' });
 }
}

// ── media store ──
function mediaStore() {
 try {
 if (window.SillyTavern && SillyTavern.libs && SillyTavern.libs.localforage) {
 return SillyTavern.libs.localforage.createInstance({ name: 'pocket-phone', storeName: 'media' });
 }
 } catch {}
 return null;
}
async function saveMedia(key, dataUrl) {
 const store = mediaStore();
 if (store) { try { await store.setItem(key, dataUrl); return true; } catch {} }
 try { localStorage.setItem('ppmedia_' + key, dataUrl); return true; } catch {}
 return false;
}
async function loadMedia(key) {
 const store = mediaStore();
 if (store) { try { const v = await store.getItem(key); if (v) return v; } catch {} }
 try { return localStorage.getItem('ppmedia_' + key); } catch {}
 return null;
}
async function delMedia(key) {
 const store = mediaStore();
 if (store) { try { await store.removeItem(key); } catch {} }
 try { localStorage.removeItem('ppmedia_' + key); } catch {}
}
/** อ่านไฟล์รูปแล้วย่อ/บีบอัดถ้าใหญ่เกินไป กันรูปมือถือ (หลาย MB) ดันโควตาที่เก็บข้อมูลจนบันทึกไม่ผ่าน
 * (บันทึกไม่ผ่านแบบเงียบ ๆ ทำให้ตอนโหลดกลับมาเจอ null แล้วเห็นเป็นกล่องดำ/รูปไม่ขึ้น) */
function ppReadImageFile(file, maxDim = 1600) {
 return new Promise(resolve => {
 const r = new FileReader();
 r.onerror = () => resolve(null);
 r.onload = () => {
 const orig = r.result;
 const img = new Image();
 img.onerror = () => resolve(orig); // ย่อไม่ได้ ใช้ต้นฉบับแทน
 img.onload = () => {
 let w = img.naturalWidth, h = img.naturalHeight;
 if (!w || !h || (w <= maxDim && h <= maxDim)) return resolve(orig);
 const scale = maxDim / Math.max(w, h);
 w = Math.round(w * scale); h = Math.round(h * scale);
 try {
 const canvas = document.createElement('canvas');
 canvas.width = w; canvas.height = h;
 const cx = canvas.getContext('2d');
 cx.drawImage(img, 0, 0, w, h);
 resolve(canvas.toDataURL('image/jpeg', 0.86));
 } catch { resolve(orig); }
 };
 img.src = orig;
 };
 r.readAsDataURL(file);
 });
}

// ── พื้นหลัง ──
const WALLPAPERS = {
 aurora: 'radial-gradient(38% 26% at 22% 15%, rgba(94,92,230,.55), transparent 72%), radial-gradient(40% 26% at 84% 22%, rgba(255,159,10,.4), transparent 72%), radial-gradient(46% 32% at 50% 92%, rgba(52,199,89,.34), transparent 72%), radial-gradient(40% 28% at 88% 82%, rgba(191,90,242,.34), transparent 72%), linear-gradient(160deg,#0a0a12,#050506)',
 ocean: 'radial-gradient(50% 40% at 30% 18%, rgba(10,132,255,.5), transparent 70%), radial-gradient(52% 42% at 82% 82%, rgba(48,209,88,.3), transparent 72%), linear-gradient(160deg,#04121f,#010409)',
 sunset: 'radial-gradient(60% 45% at 50% 14%, rgba(255,159,10,.5), transparent 72%), radial-gradient(55% 40% at 18% 90%, rgba(255,55,95,.42), transparent 72%), radial-gradient(50% 40% at 92% 70%, rgba(191,90,242,.35), transparent 72%), linear-gradient(160deg,#1a0a12,#0a0406)',
 forest: 'radial-gradient(55% 45% at 25% 20%, rgba(52,199,89,.45), transparent 72%), radial-gradient(50% 40% at 85% 82%, rgba(10,132,255,.28), transparent 72%), linear-gradient(160deg,#08120a,#040604)',
 blush: 'radial-gradient(50% 38% at 26% 16%, rgba(255,100,130,.45), transparent 72%), radial-gradient(46% 36% at 80% 78%, rgba(255,214,224,.34), transparent 72%), linear-gradient(160deg,#1a0d12,#080406)',
 mono: 'radial-gradient(70% 55% at 50% 0%, #1e1e26, #050506 72%)',
};
const CHAT_BGS = {
 '': '',
 dusk: 'linear-gradient(180deg,#1a1030,#0a0616)',
 mint: 'linear-gradient(180deg,#0a1f18,#04100c)',
 rose: 'linear-gradient(180deg,#2a0f18,#12060a)',
 steel: 'linear-gradient(180deg,#12161c,#06080b)',
 sand: 'linear-gradient(180deg,#241d12,#100c06)',
};
const STORY_BGS = [
 'linear-gradient(160deg,#5e5ce6,#bf5af2)', 'linear-gradient(160deg,#ff375f,#ff9f0a)',
 'linear-gradient(160deg,#0a84ff,#30d158)', 'linear-gradient(160deg,#1c1c1e,#3a3a3c)',
 'linear-gradient(160deg,#ff6482,#ffd60a)', 'linear-gradient(160deg,#32ade6,#5e5ce6)',
];
const POST_BGS = STORY_BGS;

const HIST_LIMIT = 30;
const HIST_PAGE = 50;
const BOT_WALLET_DEFAULT = 30000;

const DEFAULTS = {
 // ── เดิม 0.9.8 ──
 theme: 'dark', accent: '#0a84ff', dynamicIsland: true, islandScope: 'phone',
 wallpaper: 'aurora', homeBlur: 6, botCallKeyword: true, userAvatarMode: 'auto',
 sharedUniverse: false, universeAffectsRP: false,
 allowBotReplyOnPhone: false,
 keyKeepTurns: 3,
 contacts: [], threads: {}, chatStyle: {}, callLog: [], pinned: [],
 userNote: null, botNotes: {}, userAppName: '', imageCaptionMode: 'ask',
 stories: [], storySeen: {}, userPersonaMode: 'perchat', sharedUserPersonaId: '',
 showFab: true, feedPosts: [], periods: [], groups: [], notifCenter: [],
 ringtoneUrl: '', walletBalance: 50000, walletAccount: '', walletName: '',
 walletHistory: [], botWallets: {},

 // ── ★ Action Log ──
 actionLog: [], // คิวเหตุการณ์ · ล้างหลังส่ง
 logToStory: true, // เปิด/ปิดการแทรกเข้าบทหลัก
 logIdleNote: false, // แทรกบรรทัด "ไม่ได้แตะมือถือ" เมื่อไม่มีอะไร
 logMinorActions: false, // ติดดาว/ปิดเสียง/เก็บถาวร เข้าบล็อกด้วยไหม
 logWrapMode: 'prompt', // legacy setting; 1.2+ injects actions as an ephemeral system prompt
 logMaxEvents: 60,
 logStamps: [],

 // ── ★ ประจำเดือน ──
 periodLogs: {}, // 'YYYY-MM-DD' -> {flow, symptoms[], mood, note}
 periodShareBot: true,
 periodCareLevel: 'normal',
 periodSharedWith: null, // null = ทุกคน
 periodCycleLen: 28,
 periodDuration: 5,

 // ── ★ โปรไฟล์ / บัญชี ──
 userHandle: '', userBio: '', userLink: '',
 accountLocked: false, followRequests: [], followers: [], following: [],
 closeFriends: [], blocked: [], restricted: [],
 postVisibilityDefault: 'all',

 // ── ★ แชท extras (ไม่มี vanish · ไม่มี relationship) ──
 stickerPacks: [], mutedChats: [], archivedChats: [],
 starred: {}, // ★ tid -> [mid,...] แทนปักหมุด
 drafts: {}, scheduled: {}, unread: {},

 // ── ★ ฟีด extras ──
 savedPosts: [], archivedPosts: [], storyHighlights: [], hashtagSeen: {},

 // ── ★ Wallet extras ──
 walletCurrency: '฿', walletDailyLimit: 0, walletRequests: [],

 // ── ★ UI ──
 fabPos: null, // {xPct, yPct} กัน viewport เปลี่ยน
 headerCompact: true,
 showFabBadge: true,

 // ── ★ Scope ตามคาร์ ──
 ppShowAllContacts: false,
 strictNpcScope: false,

 // ── ★ 1.0.0 : ผีและชื่อเสียง ──
 ghostEnabled: true,          // เปิดระบบผี (ล็อคแอคแล้วจะถูกปิดอัตโนมัติ)
 ghostFollowers: 0,           // ผู้ติดตามผี (ตัวเลขล้วน ไม่ใช่คอนแทกต์)
 ghostFollowHistory: [],      // [{ts, delta, reason}] เก็บไว้ 60 รายการ
 ghostRegulars: [],           // [{name, handle}] แฟนคลับประจำที่โผล่ซ้ำ
 ghostViewerNames: [],        // แคชชื่อผีที่โมเดลเคยตั้ง (ไม่ต้องยิง API ซ้ำ)
 dramaLevel: 'normal',        // calm | normal | spicy — ความง่ายในการเกิดดราม่า
 lastGhostTick: 0,            // กันคิดยอดฟอลซ้ำในโพสต์เดิม
 ghostDmChance: 2,            // % ที่ผีจะทักแชทจริง (0-5)

 // ── ★ 1.0.0 : รีโพสต์ / แท็ก / ข่าว ──
 newsSeen: {},                // pid -> true
 mentionsInbox: [],           // [{id, pid, cid, text, ts, seen}]

 // ── ★ 1.0.0 : กระเป๋าเงินแยกตามรูทแชท ──
 walletPerChat: false,        // เปิด = ยอดเงิน/ประวัติแยกตามแชท ST
 walletRoutes: {},            // routeKey -> {balance, history, botWallets}

 // ── ★ 1.1.0 : strict one-request engine ──
 singleRequestMode: true,     // hard cap: no automatic retry / no hidden follow-up generation
 autoSyncEnabled: true,       // piggyback one phone update batch on the normal ST reply
 syncReceipts: true,          // show and retain applied/noop/missing/invalid confirmation
 syncMaxEvents: 8,            // protect the phone from runaway model output
 lastSyncReceipt: null,       // {status, applied, ignored, detail, ts}
 syncStats: { turns: 0, applied: 0, noop: 0, missing: 0, invalid: 0 },
 processedMainSync: [],       // stable fingerprints prevent replay after the data frame is removed

 // ── ★ 1.3.0 : bridge modules — เปิด/ปิดรายอัน วัดโทเคนจริง ──
 bridgeMods: {
  msg: true,       // ข้อความ/แชท (dm, voice, sticker, location, gift, unsend, story_reply)
  groupcall: true, // กลุ่ม + โทร
  feed: false,     // ฟีด/โพสต์/คอมเมนต์/ไลก์/รีโพสต์/โพล
  story: false,    // สตอรี่
  wallet: true,    // กระเป๋าเงิน
  social: false,   // ติดตาม/สเตตัส/ชื่อเล่น
  news: false,     // ข่าว
  inv_contacts: true,  // ส่งรายชื่อคอนแทกต์
  inv_posts: false,    // ส่งโพสต์/สตอรี่ล่าสุด
  inv_ui: false,       // ส่งสถานะ UI มือถือ
  inv_stickers: false, // ส่งรายชื่อป้ายสติกเกอร์
  actionlog: true,     // ส่งบันทึกกิจกรรมที่ผู้ใช้ทำ
 },
 dramaEnabled: false,   // ระบบดราม่า/clout ทั้งชุด
 bridgeTokenCache: null, // {total, mods:{}, measuredAt, tokenizer, ok}
 syncEventLog: [],       // [{ts, ok, type, label, reason}] เก็บ 120
 callHistoryOpen: false, // ปุ่มสลับดูประวัติในสาย

 // ── ★ 1.4.0 : contact scope + nickname + bot powers ──
 contactSendMode: 'relevant', // off | relevant | all
 contactSendLimit: 12,        // เพดานเมื่อโหมด relevant
 nicknameNotify: true,        // แจ้งในแชทเมื่อบอทตั้งชื่อเล่นให้เรา
 botCanMakeGroup: true,       // บอทสร้างกลุ่ม + ดึงเราเข้ากลุ่มได้
 botCanSetWallet: true,       // บอทกำหนดยอดเงินตัวเองได้
 unsendPeekEnabled: true,     // เราส่องข้อความที่บอทยกเลิกได้
};
const LS_MIRROR = 'pp_cfg_mirror';

function getCfg() {
 const c = ctx();
 let cfg;
 if (c && c.extensionSettings) {
 if (!c.extensionSettings[MODULE_NAME]) c.extensionSettings[MODULE_NAME] = {};
 cfg = c.extensionSettings[MODULE_NAME];
 } else {
 try { cfg = JSON.parse(localStorage.getItem(LS_MIRROR) || '{}'); } catch { cfg = {}; }
 }
 // backfill key-by-key ทุกครั้ง — ผู้ใช้เก่าไม่ค่าหาย
 for (const k of Object.keys(DEFAULTS)) if (cfg[k] === undefined) cfg[k] = structuredClone(DEFAULTS[k]);
 // ★ 1.3.0 backfill ระดับลูกของ bridgeMods (ผู้ใช้เก่าที่มี object แล้วแต่ขาดคีย์ใหม่)
 if (!cfg.bridgeMods || typeof cfg.bridgeMods !== 'object') cfg.bridgeMods = structuredClone(DEFAULTS.bridgeMods);
 else for (const k of Object.keys(DEFAULTS.bridgeMods)) if (cfg.bridgeMods[k] === undefined) cfg.bridgeMods[k] = DEFAULTS.bridgeMods[k];
 if (!Array.isArray(cfg.syncEventLog)) cfg.syncEventLog = [];
 // ★ กวาดคีย์ที่เลิกใช้ (0.9.8 → 0.9.9)
 if (cfg.relationship !== undefined) delete cfg.relationship;
 if (cfg.pinnedMsgs !== undefined) {
 try { for (const k of Object.keys(cfg.pinnedMsgs)) { if (!cfg.starred[k]) cfg.starred[k] = cfg.pinnedMsgs[k]; } } catch {}
 delete cfg.pinnedMsgs;
 }
 if (cfg.lastMobileDelta !== undefined) delete cfg.lastMobileDelta;
 return cfg;
}
function saveCfg() {
 const c = ctx(), cfg = getCfg();
 try { localStorage.setItem(LS_MIRROR, JSON.stringify(cfg)); } catch {}
 try { if (c && typeof c.saveSettingsDebounced === 'function') c.saveSettingsDebounced(); } catch {}
}

const esc = s => String(s == null ? '' : s)
 .replace(/&/g, '&').replace(/</g, '<').replace(/>/g, '>').replace(/"/g, '"');

// ══════════════════════════════════════════════════════════
// ด่านกรองข้อความบอท
// ══════════════════════════════════════════════════════════
const _THOUGHT_TAGS = 'think|thinking|thought|thoughts|reason|reasoning|reflection|reflect|analysis|analyze|analyzing|plan|planning|planner|strategy|scratchpad|inner[_ ]?monologue|monologue|cot|meta|system|note[_ ]?to[_ ]?self';

function cleanReply(t) {
 let s = String(t || '');
 s = s.replace(new RegExp(`<(${_THOUGHT_TAGS})[^>]*>[\\s\\S]*?<\\/(?:${_THOUGHT_TAGS})>`, 'gi'), '');
 s = s.replace(new RegExp(`<(${_THOUGHT_TAGS})[^>]*>[\\s\\S]*`, 'gi'), '');
 s = s.replace(new RegExp(`^\\s*(?:${_THOUGHT_TAGS})\\s*[:：].*$`, 'gim'), '');
 s = s.replace(/\(\([\s\S]*?\)\)/g, '');
 s = s.replace(/<!--[\s\S]*?-->/g, ''); // ★ กันบอท echo Action Log กลับมา
 s = s.replace(/\[\[POCKET_PHONE_SYNC_V2\]\][\s\S]*?\[\[\/POCKET_PHONE_SYNC_V2\]\]/gi, '');
 s = s.replace(/<\/?[a-z][^>]*>/gi, '');
 return s.trim();
}
function looksLikeThought(line) {
 const s = String(line || '').trim();
 if (!s) return true;
 if (/^[\[(].*[\])]$/.test(s) && s.length > 6) return true;
 if (/^\*.*\*$/.test(s)) return true;
 if (/^_.+_$/.test(s) && s.length > 8) return true;
 if (new RegExp(`^(?:${_THOUGHT_TAGS})\\b\\s*[:\\-–]`, 'i').test(s)) return true;
 if (/^(?:to (?:my|him|her)self|i think to myself|\(thinks?\b|internally\b)/i.test(s)) return true;
 return false;
}
// ★ 0.9.9 มี STICKER / POLL / LOCATION — ไม่มี REACT
const PP_CMD_RX = /\[(NOTE|VOICE|NOTEREPLY|STICKER|POLL|LOCATION|UNSEND|PP_CALL|PP_MSG|PP_NEWCHAT|PP_PAY|PP_EARN|PP_FOLLOW|LIKES)[^\]]*\][^\n]*/gi;

function extractSpoken(raw) {
 let s = String(raw || '');
 s = s.replace(PP_CMD_RX, '');
 s = cleanReply(s);
 const out = [];
 const rx = /["“”„«»「」『』]([^"“”„«»「」『』\r\n]{1,})["“”„«»「」『』]/g;
 let m;
 while ((m = rx.exec(s))) {
 let t = stripEmoji(m[1].trim()).replace(/^[\-–•\s]+/, '').trim();
 if (t && !looksLikeThought(t)) out.push(t);
 }
 return out;
}
function spokenOrFallback(raw, maxLines) {
 const q = extractSpoken(raw);
 if (q.length) return q.slice(0, maxLines || 3);
 let s = String(raw || '').replace(PP_CMD_RX, '');
 s = cleanReply(s);
 const lines = s.split(/\n+/)
 .map(l => stripEmoji(l.trim().replace(/^["'“”‘’„«»「」『』]+|["'“”‘’„«»「」『』]+$/g, '')).trim())
 .filter(Boolean).filter(l => !looksLikeThought(l));
 return lines.slice(0, maxLines || 3);
}
function stripEmoji(t) {
 return String(t || '')
 .replace(/[\u{1F000}-\u{1FAFF}]/gu, '').replace(/[\u{2600}-\u{27BF}]/gu, '')
 .replace(/[\u{2B00}-\u{2BFF}]/gu, '').replace(/[\u{1F1E6}-\u{1F1FF}]/gu, '')
 .replace(/[\u{2190}-\u{21FF}]/gu, '').replace(/[\uFE0F\u200D\u20E3]/gu, '')
 .replace(/[ \t]{2,}/g, ' ').trim();
}
function isFarewell(t) {
 const s = String(t || '').toLowerCase();
 if (/\b(bye+|goodbye|talk (to you )?later|see (you|ya)|see u|gtg|got to go|gotta go|hang up|catch you later|call you (back|later)|take care)\b/.test(s)) return true;
 return /(บายนะ|บายๆ|บาย|วางก่อน|วางละ|วางสายก่อน|วางสายละ|ไปก่อนนะ|ไปก่อน|ไปละ|ต้องไปแล้ว|ต้องวางแล้ว|แล้วเจอกัน|แล้วค่อยคุย|ไว้คุยกัน|ไว้คุยกันใหม่|ไว้คุยใหม่|แค่นี้ก่อน|เดี๋ยวโทรใหม่|เดี๋ยวโทรกลับ|ราตรีสวัสดิ์|ฝันดี|โชคดีนะ|ดูแลตัวเองด้วย)/.test(t || '');
}
function wantsToCall(t) {
 const s = String(t || '');
 if (/(โทรหา|โทรไป|โทรกลับ|ขอโทร|กำลังโทร|เดี๋ยวโทร|รับสายหน่อย|โทรได้ไหม|โทรเลย)/.test(s)) return true;
 if (/\b(calling you|i'?ll call|gonna call|pick up|answer the phone)\b/i.test(s)) return true;
 return false;
}

// ── identity ──
function getUserName() {
 const c = ctx();
 try { if (c && c.name1) return c.name1; } catch {}
 return 'User';
}
function getUserDisplayName() {
 const cfg = getCfg();
 return (cfg.userAppName && cfg.userAppName.trim()) || getUserName();
}
function getUserHandle() {
 const cfg = getCfg();
 if (cfg.userHandle && cfg.userHandle.trim()) return cfg.userHandle.trim().replace(/^@/, '');
 return getUserDisplayName().replace(/\s+/g, '').toLowerCase();
}
function dname(c) { return (c && (c.customName || c.name)) || '?'; }
function newId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function newMid() { return 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

function currentCharacterId() {
 const c = ctx();
 try {
 if (c && c.characterId != null && Array.isArray(c.characters)) {
 const ch = c.characters[c.characterId];
 if (ch) return ch.avatar || ch.name;
 }
 } catch {}
 return null;
}
function ppStChatId() {
 const c = ctx();
 try {
 if (c) {
 if (c.chatId != null) return String(c.chatId);
 if (c.getCurrentChatId && typeof c.getCurrentChatId === 'function') { const v = c.getCurrentChatId(); if (v) return String(v); }
 if (Array.isArray(c.characters) && c.characterId != null) { const ch = c.characters[c.characterId]; if (ch && ch.chat) return String(ch.chat); }
 }
 } catch {}
 return '';
}
// thread key = ผูกกับแชทของ ST ปัจจุบัน · ถ้าอ่านไม่ได้ fallback เป็น cid เดี่ยว (พฤติกรรมเดิม)
function threadKey(cid) {
 if (cid !== currentCharacterId()) return cid; // NPC/บอทอื่น ไม่ผูกกับไฟล์แชท ST
 const chatId = ppStChatId();
 return chatId ? `${cid}::${chatId}` : cid;
}
function getContacts() { return getCfg().contacts; }
function findContact(cid) { return getContacts().find(x => x.id === cid) || null; }
function cname(cid) { const c = findContact(cid); return c ? dname(c) : (cid || '?'); }
// contact นี้อยู่ใน scope ของคาร์ที่เปิดอยู่ไหม
function ppContactInScope(c) {
 if (!c) return false;
 const scope = currentCharacterId();
 if (!scope) return true; // ไม่เปิดคาร์ไหน → แสดงทั้งหมด (เหมือนเดิม)
 if (getCfg().ppShowAllContacts) return true; // ปุ่มแสดงทั้งหมด override
 if (c.id === scope) return true; // ตัวคาร์เอง
 if (c.baseCharId === scope) return true; // NPC สร้างเองที่อ้างอิงคาร์นี้
 if (c.ownerCharId === scope) return true; // NPC ออโต้ที่เกิดจากคาร์นี้
 // NPC ไม่ผูกใคร: โหมดเข้ม = ซ่อน · โหมดผ่อน = โผล่ทุกคาร์ (กันของเก่าหาย)
 if (c.npc && !c.baseCharId && !c.ownerCharId) return !getCfg().strictNpcScope;
 return false;
}
function ppScopeActive() {
 return !!currentCharacterId() && !getCfg().ppShowAllContacts;
}
function isPinned(id) { return (getCfg().pinned || []).includes(id); }
function isMuted(id) { return (getCfg().mutedChats || []).includes(id); }
function isArchived(id) { return (getCfg().archivedChats || []).includes(id); }
function isBlocked(cid) { return (getCfg().blocked || []).includes(cid); }
function isRestricted(cid) { return (getCfg().restricted || []).includes(cid); }
function noteCategory(cid) {
 if (isPinned(cid)) return 'pin';
 if (cid === currentCharacterId()) return 'main';
 return 'npc';
}
function contactCategory(c) {
 if (isPinned(c.id)) return 'pin';
 if (c.npc) return 'npc';
 return 'char';
}
function isGroupId(id) { return typeof id === 'string' && id.startsWith('grp:'); }
function getGroups() { return getCfg().groups || []; }
function getGroup(id) { return getGroups().find(g => g.id === id); }
function groupMemberContacts(g) {
 if (!g) return [];
 return (g.members || []).map(cid => findContact(cid)).filter(Boolean);
}
function getThread(id) {
 const cfg = getCfg();
 const key = threadKey(id);
 // migration ครั้งเดียว: ถ้ามี thread เดิมใต้ cid ดิบ และ key ใหม่ยังไม่มี ให้ย้ายมา
 if (key !== id && cfg.threads[id] && cfg.threads[id].length && !cfg.threads[key]) {
 cfg.threads[key] = cfg.threads[id];
 delete cfg.threads[id];
 saveCfg();
 }
 if (!cfg.threads[key]) cfg.threads[key] = [];
 return cfg.threads[key];
}
function lastTs(id) { const th = getThread(id); const last = th[th.length - 1]; return last ? (last.ts || 0) : 0; }
function getFeedPosts() { return getCfg().feedPosts || []; }
function findPost(id) { return getFeedPosts().find(p => p.id === id); }

// ── เวลา / ตัวเลข ──
const TH_DAYS = ['อา.', 'จ.', 'อ.', 'พ.', 'พฤ.', 'ศ.', 'ส.'];
const TH_MONTHS = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
const TH_MONTHS_FULL = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน', 'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];
function ppNow() { const d = new Date(); return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`; }
function fmtHM(d) { return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`; }
function ppDateLabel() {
 const d = new Date();
 return `${TH_DAYS[d.getDay()]} ${d.getDate()} ${TH_MONTHS[d.getMonth()]}`;
}
function fmtListTime(ts) {
 if (!ts) return '';
 const d = new Date(ts), today = new Date();
 if (d.toDateString() === today.toDateString()) return fmtHM(d);
 const yst = new Date(); yst.setDate(yst.getDate() - 1);
 if (d.toDateString() === yst.toDateString()) return 'เมื่อวาน';
 if ((today - d) < 7 * 86400000) return TH_DAYS[d.getDay()];
 return `${d.getDate()}/${d.getMonth() + 1}`;
}
function fmtNoteAge(ts) {
 if (!ts) return '';
 const mins = Math.floor((Date.now() - ts) / 60000);
 if (mins < 1) return 'เมื่อกี้';
 if (mins < 60) return `${mins} นาทีที่แล้ว`;
 const hrs = Math.floor(mins / 60);
 if (hrs < 24) return `${hrs} ชม.ที่แล้ว`;
 const days = Math.floor(hrs / 24);
 if (days < 7) return `${days} วันที่แล้ว`;
 return `${Math.floor(days / 7)} สัปดาห์ที่แล้ว`;
}
function chatDividerFull(ts) {
 if (!ts) return '';
 const d = new Date(ts), today = new Date();
 if (d.toDateString() === today.toDateString()) return `วันนี้ ${fmtHM(d)}`;
 return `${TH_DAYS[d.getDay()]} ${d.getDate()} ${TH_MONTHS[d.getMonth()]} · ${fmtHM(d)}`;
}
function chatDivider(prevTs, ts) {
 if (!prevTs || !ts) return '';
 if (ts - prevTs < 300000) return '';
 const d = new Date(ts), p = new Date(prevTs);
 if (d.toDateString() === p.toDateString()) return fmtHM(d);
 const today = new Date();
 if (d.toDateString() === today.toDateString()) return `วันนี้ ${fmtHM(d)}`;
 return `${TH_DAYS[d.getDay()]} ${d.getDate()} ${TH_MONTHS[d.getMonth()]} · ${fmtHM(d)}`;
}
function fmtDur(s) {
 s = Math.max(1, Math.round(s || 1));
 return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
function fmtMoney(n) {
 const cfg = getCfg();
 const v = Math.round(Number(n) || 0);
 return (cfg.walletCurrency || '฿') + v.toLocaleString('en-US');
}
const PP_CURRENCIES = ['฿', '₩', '$', '¥', '€', '£', 'G', 'pt'];
function ymd(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
function ymdLabel(s) {
 if (!s) return '';
 const [y, m, d] = s.split('-').map(Number);
 return `${d} ${TH_MONTHS[m - 1]}`;
}

// ══════════════════════════════════════════════════════════
// ★★★ ACTION LOG — หัวใจของ 0.9.9 ★★★
// ══════════════════════════════════════════════════════════
// Legacy-only cleanup. New action data is never written into chat messages.
const PP_MARK_RX = /<!--\s*Pocket Phone[\s\S]*?-->/g;
const PP_HIDDEN_RX = /<div\s+data-pp-log[\s\S]*?<\/div>/g;

const LOG_SECTIONS = [
 ['chat', '[แชท]'],
 ['group', '[แชทกลุ่ม]'],
 ['call', '[โทรศัพท์]'],
 ['feed', '[ฟีด]'],
 ['story', '[สตอรี่]'],
 ['wallet', '[กระเป๋าเงิน]'],
 ['note', '[สเตตัส]'],
 ['account', '[บัญชี]'],
 ['period', '[ประจำเดือน]'],
 ['misc', '[อื่น ๆ]'],
];

/**
 * ★ บันทึกเหตุการณ์ — ทุกแอปเรียกตัวนี้
 * @param {string} kind chat|group|call|feed|story|wallet|note|account|period|misc
 * @param {string} text บรรทัดหลัก (ไทย อ่านรู้เรื่องทันที)
 * @param {string[]} [sub] บรรทัดย่อย (transcript สาย, คอมเมนต์, รายละเอียด)
 */
function ppLog(kind, text, sub) {
 try {
 const cfg = getCfg();
 if (!cfg.logToStory) return;
 if (!text) return;
 cfg.actionLog.push({
 id: newId(),
 kind: kind || 'misc',
 text: String(text).slice(0, 600),
 sub: Array.isArray(sub) ? sub.filter(Boolean).map(s => String(s).slice(0, 400)).slice(0, 14) : null,
 ts: Date.now(),
 });
 const cap = Math.max(20, (cfg.logMaxEvents || 60) * 4);
 if (cfg.actionLog.length > cap) cfg.actionLog = cfg.actionLog.slice(-cap);
 saveCfg();
 ppUpdateLogBadge();
 } catch (e) { console.warn('[pocket-phone] ppLog', e); }
}
/** เหตุการณ์ส่วนตัว (ติดดาว/ปิดเสียง/เก็บถาวร) — เข้าคิวเฉพาะเมื่อเปิด logMinorActions */
function ppLogMinor(kind, text, sub) {
 if (!getCfg().logMinorActions) return;
 ppLog(kind, text, sub);
}
function ppLogCount() { try { return (getCfg().actionLog || []).length; } catch { return 0; } }
function ppUpdateLogBadge() {
 try {
 const show = getCfg().showFabBadge !== false;
 const n = show ? ppLogCount() : 0;
 document.querySelectorAll('.pp-logbadge').forEach(el => {
 el.textContent = n ? String(n) : '';
 el.classList.toggle('on', n > 0);
 });
 } catch {}
}

/** เนื้อในบล็อก (ยังไม่ห่อ) */
function ppBuildLogBody() {
 const cfg = getCfg();
 let events = (cfg.actionLog || []).slice();
 if (!events.length) return '';
 const max = Math.max(5, cfg.logMaxEvents || 60);
 if (events.length > max) events = events.slice(-max);

 const buckets = {};
 events.forEach(e => {
 const k = e.kind || 'misc';
 if (!buckets[k]) buckets[k] = [];
 buckets[k].push(e);
 });

 const parts = [];
 for (const [key, label] of LOG_SECTIONS) {
 const arr = buckets[key];
 if (!arr || !arr.length) continue;
 const lines = [label];
 arr.forEach(e => {
 lines.push(`- ${e.text}`);
 if (e.sub && e.sub.length) e.sub.forEach(s => lines.push(` ${s}`));
 });
 parts.push(lines.join('\n'));
 }
 if (!parts.length) return '';
 return parts.join('\n\n');
}
function ppLogPlainSummary() { return ppBuildLogBody() || ''; }

/**
 * Compatibility console hook. Since 1.2, phone actions stay in local state and
 * are injected by ppGenInterceptor for one generation only. Nothing is written
 * into the user's message and the queue is cleared only after a reply arrives.
 */
async function ppStampUserMessage() {
 try {
 const cfg = getCfg();
 if (!cfg.logToStory) return { ok: false, reason: 'ปิดการแทรก' };
 let body = ppBuildLogBody();
 if (!body) {
 if (!cfg.logIdleNote) return { ok: false, reason: 'ไม่มีกิจกรรม' };
 body = `[อื่น ๆ]\n- ${getUserDisplayName()} ไม่ได้แตะมือถือช่วงนี้`;
 }
 return { ok: true, queued: (cfg.actionLog || []).length, transport: 'ephemeral-system-prompt', preview: body };
 } catch (e) {
 console.error('[pocket-phone] ppStampUserMessage', e);
 return { ok: false, reason: e.message };
 }
}

/** ล้างบล็อก legacy รุ่นเก่าออกจากทั้งแชท */
async function ppStripAll() {
 try {
 const c = ctx();
 if (!c || !Array.isArray(c.chat)) { console.warn('[pocket-phone] ไม่มี chat'); return 0; }
 let n = 0;
 c.chat.forEach(m => {
 if (!m || typeof m.mes !== 'string') return;
 const before = m.mes;
 let after = before.replace(PP_MARK_RX, '').replace(PP_HIDDEN_RX, '');
 after = after.replace(/\n{3,}/g, '\n\n').trim();
 if (after !== before) { m.mes = after; n++; }
 });
 const cfg = getCfg();
 cfg.logStamps = [];
 saveCfg();
 if (n) await ppSaveChatNow();
 console.log(`[pocket-phone] ล้างบล็อกออกจาก ${n} ข้อความ - รีเฟรชหน้าเพื่อดูผล`);
 return n;
 } catch (e) { console.error('[pocket-phone] ppStripAll', e); return 0; }
}
function ppPreviewLog() {
 const body = ppBuildLogBody();
 if (!body) return '(ยังไม่มีกิจกรรมค้างคิว — ลองทําอะไรในแอปก่อน เช่น ส่งข้อความ กดถูกใจ โอนเงิน)';
 // preview แสดงเนื้อล้วน อ่านได้ ไม่ห่อ comment (การแทรกจริงยังใช้ ppWrapLogBlock ตามเดิม)
 const un = getUserDisplayName();
 return `[Pocket Phone — สิ่งที่ ${un} เพิ่งทําบนมือถือ]\n\n${body}`;
}

// ══════════════════════════════════════════════════════════
// ★ ประจำเดือน — เหตุการณ์ลง log · สถานะฉีดสดทุกเทิร์น
// ══════════════════════════════════════════════════════════
const PERIOD_SYMPTOMS = ['ปวดท้อง', 'ปวดหลัง', 'ปวดหัว', 'เพลีย', 'สิว', 'ท้องอืด', 'อยากของหวาน', 'นอนไม่หลับ', 'คลื่นไส้', 'เจ็บหน้าอก'];
const PERIOD_MOODS = ['ปกติ', 'หงุดหงิด', 'เศร้า', 'อารมณ์ดี', 'ขี้ใจน้อย', 'เฉยชา'];
const PERIOD_FLOWS = ['น้อย', 'กลาง', 'มาก'];

function getPeriodDays() { return getCfg().periods || []; }
function isPeriodDay(s) { return getPeriodDays().includes(s); }
function getPeriodLog(s) {
 const cfg = getCfg();
 if (!cfg.periodLogs[s]) cfg.periodLogs[s] = { flow: '', symptoms: [], mood: '', note: '' };
 const l = cfg.periodLogs[s];
 if (!Array.isArray(l.symptoms)) l.symptoms = [];
 return l;
}
function hasPeriodLog(s) {
 const l = (getCfg().periodLogs || {})[s];
 return !!(l && (l.flow || l.mood || l.note || (l.symptoms && l.symptoms.length)));
}
function togglePeriodDay(s) {
 const cfg = getCfg();
 if (!cfg.periods) cfg.periods = [];
 const i = cfg.periods.indexOf(s);
 if (i >= 0) {
 cfg.periods.splice(i, 1);
 ppLog('period', `ยกเลิกเครื่องหมายวันประจำเดือน (${ymdLabel(s)})`);
 } else {
 cfg.periods.push(s);
 ppLog('period', s === ymd(new Date()) ? 'ทำเครื่องหมายว่าประจำเดือนมาวันนี้' : `ทำเครื่องหมายวันประจำเดือน (${ymdLabel(s)})`);
 }
 cfg.periods.sort();
 saveCfg();
}
function savePeriodLog(s, data) {
 const l = getPeriodLog(s);
 Object.assign(l, data);
 saveCfg();
 const bits = [];
 if (l.flow) bits.push(`ปริมาณ ${l.flow}`);
 if (l.symptoms.length) bits.push(`อาการ ${l.symptoms.join(', ')}`);
 if (l.mood) bits.push(`อารมณ์ ${l.mood}`);
 if (l.note) bits.push(`โน้ต "${l.note}"`);
 if (bits.length) ppLog('period', `บันทึกอาการ (${ymdLabel(s)}) - ${bits.join(' · ')}`);
}

function periodCycles() {
 const days = getPeriodDays().slice().sort();
 const cycles = [];
 let cur = null;
 days.forEach(s => {
 if (cur) {
 const prev = new Date(cur.end);
 prev.setDate(prev.getDate() + 1);
 if (ymd(prev) === s) { cur.end = s; cur.len++; return; }
 cycles.push(cur);
 }
 cur = { start: s, end: s, len: 1 };
 });
 if (cur) cycles.push(cur);
 return cycles;
}
function periodAvg() {
 const cycles = periodCycles();
 const cfg = getCfg();
 if (cycles.length < 2) {
 return { cycleLen: cfg.periodCycleLen || 28, duration: cycles[0] ? cycles[0].len : (cfg.periodDuration || 5), samples: cycles.length };
 }
 let gapSum = 0;
 for (let i = 1; i < cycles.length; i++) {
 gapSum += Math.round((new Date(cycles[i].start) - new Date(cycles[i - 1].start)) / 86400000);
 }
 const durSum = cycles.reduce((s, c) => s + c.len, 0);
 return {
 cycleLen: Math.round(gapSum / (cycles.length - 1)) || 28,
 duration: Math.round(durSum / cycles.length) || 5,
 samples: cycles.length,
 };
}
function periodTodayInfo() {
 const days = getPeriodDays(), today = ymd(new Date());
 const avg = periodAvg();
 if (days.includes(today)) {
 let d = 1, cur = new Date();
 while (true) { cur.setDate(cur.getDate() - 1); if (days.includes(ymd(cur))) d++; else break; }
 return { onPeriod: true, dayNum: d, avg, phase: 'period' };
 }
 const cycles = periodCycles();
 const last = cycles[cycles.length - 1];
 if (last) {
 const nextStart = new Date(last.start);
 nextStart.setDate(nextStart.getDate() + avg.cycleLen);
 const daysUntil = Math.round((nextStart - new Date(today)) / 86400000);
 const sinceStart = Math.round((new Date(today) - new Date(last.start)) / 86400000);
 const ovu = avg.cycleLen - 14;
 let phase = 'follicular';
 if (Math.abs(sinceStart - ovu) <= 2) phase = 'ovulation';
 else if (sinceStart > ovu) phase = 'luteal';
 return { onPeriod: false, upcomingIn: daysUntil, sinceStart, avg, phase, nextStart: ymd(nextStart) };
 }
 return { onPeriod: false, avg, phase: null };
}
function periodPredicted() {
 const info = periodTodayInfo();
 if (!info.nextStart) return [];
 const out = [];
 const d = new Date(info.nextStart);
 for (let i = 0; i < (info.avg.duration || 5); i++) { out.push(ymd(d)); d.setDate(d.getDate() + 1); }
 return out;
}
function periodOvulationDays() {
 const cycles = periodCycles();
 const last = cycles[cycles.length - 1];
 if (!last) return [];
 const avg = periodAvg();
 const d = new Date(last.start);
 d.setDate(d.getDate() + Math.max(7, avg.cycleLen - 15));
 const out = [];
 for (let i = 0; i < 3; i++) { out.push(ymd(d)); d.setDate(d.getDate() + 1); }
 return out;
}
function phaseLabel(p) {
 return ({ period: 'มีประจำเดือน', follicular: 'ช่วงปลอดภัย', ovulation: 'ช่วงไข่ตก', luteal: 'ก่อนรอบถัดไป' })[p] || 'ยังไม่มีข้อมูล';
}

/** ★ สถานะที่ฉีดเข้า prompt — โปร่งใส ผู้ใช้อ่านได้ในแอป */
function periodPromptNote(forCid) {
 const cfg = getCfg();
 if (!cfg.periodShareBot) return '';
 if (Array.isArray(cfg.periodSharedWith) && forCid && !cfg.periodSharedWith.includes(forCid)) return '';
 const info = periodTodayInfo();
 const un = getUserDisplayName();
 const log = (cfg.periodLogs || {})[ymd(new Date())];
 const care = cfg.periodCareLevel || 'normal';

 const bits = [];
 if (info.onPeriod) {
 bits.push(`${un} is on their period (day ${info.dayNum}).`);
 if (log) {
 const p = [];
 if (log.symptoms && log.symptoms.length) p.push(log.symptoms.slice(0, 3).join(', '));
 if (log.mood) p.push('mood: ' + log.mood);
 if (p.length) bits.push(p.join(' · ') + '.');
 }
 bits.push(care === 'light' ? 'Do not bring it up unless they do.'
 : care === 'high' ? 'Be attentive but not over the top.'
 : 'Be gently considerate.');
 } else if (info.upcomingIn != null && info.upcomingIn >= 0 && info.upcomingIn <= 3) {
 bits.push(`${un}'s period expected in ~${info.upcomingIn} day(s).`);
 } else if (log && (log.symptoms?.length || log.mood)) {
 const p = [];
 if (log.symptoms?.length) p.push(log.symptoms.slice(0, 3).join(', '));
 if (log.mood) p.push('mood: ' + log.mood);
 if (p.length) bits.push(`${un} today — ${p.join(' · ')}.`);
 }
 return bits.join(' ');
}

// ══════════════════════════════════════════════════════════
// ★ ข้อความติดดาว (แทนปักหมุด · ไม่ใช้กดค้าง)
// ══════════════════════════════════════════════════════════
function getStarred(tid) {
 const cfg = getCfg();
 const key = threadKey(tid);
 // migration ครั้งเดียว: ย้าย starred เดิมจาก cid ดิบเข้า key ใหม่
 if (key !== tid && cfg.starred[tid] && cfg.starred[tid].length && !cfg.starred[key]) {
 cfg.starred[key] = cfg.starred[tid];
 delete cfg.starred[tid];
 saveCfg();
 }
 if (!cfg.starred[key]) cfg.starred[key] = [];
 return cfg.starred[key];
}
function isStarred(tid, mid) { return !!mid && getStarred(tid).includes(mid); }
function toggleStar(tid, mid) {
 if (!mid) return false;
 const arr = getStarred(tid);
 const i = arr.indexOf(mid);
 if (i >= 0) { arr.splice(i, 1); saveCfg(); return false; }
 arr.push(mid);
 if (arr.length > 60) arr.shift();
 saveCfg();
 const m = getThread(tid).find(x => x.mid === mid);
 if (m) ppLogMinor('misc', `ติดดาวข้อความในแชท ${isGroupId(tid) ? (getGroup(tid)?.name || 'กลุ่ม') : cname(tid)}: "${String(m.text || '').slice(0, 60)}"`);
 return true;
}
function starredMsgs(tid) {
 const ids = getStarred(tid);
 if (!ids.length) return [];
 return getThread(tid).filter(m => m.mid && ids.includes(m.mid));
}

// ══════════════════════════════════════════════════════════
// ★ Image Caption — 3 ชั้น fallback ไม่เดา API ตัวเดียว
// ══════════════════════════════════════════════════════════
async function ppCaptionViaContext(dataUrl) {
 const c = ctx();
 ppDetect();
 if (!PP_CAP.multimodal) return '';
 const base64 = String(dataUrl).split(',')[1] || '';
 try {
 const cap = await c.getMultimodalCaption(base64, 'บรรยายรูปนี้สั้น ๆ เป็นภาษาไทย');
 return cap ? stripEmoji(cleanReply(cap)).slice(0, 240) : '';
 } catch (e) { console.warn('[pocket-phone] multimodal caption failed', e); return ''; }
}
async function ppCaptionViaGlobal(dataUrl) {
 if (typeof window.getMultimodalCaption !== 'function') return '';
 const base64 = String(dataUrl).split(',')[1] || '';
 try {
 const cap = await window.getMultimodalCaption(base64, 'บรรยายรูปนี้สั้น ๆ เป็นภาษาไทย');
 return cap ? stripEmoji(cleanReply(cap)).slice(0, 240) : '';
 } catch { return ''; }
}
async function ppCaptionViaSlash() {
 const c = ctx();
 ppDetect();
 if (!PP_CAP.slash) return '';
 try {
 const res = await Promise.race([
 c.executeSlashCommandsWithOptions('/caption quiet=true', { handleExecutionErrors: true }),
 new Promise(r => setTimeout(() => r(null), 20000)),
 ]);
 const out = res && (res.pipe || res.result || '');
 return out ? stripEmoji(cleanReply(String(out))).slice(0, 240) : '';
 } catch (e) { console.warn('[pocket-phone] /caption failed', e); return ''; }
}
/** ไล่ 3 ชั้น · คืน '' ถ้าไม่ได้ → ผู้เรียกต้องถามให้พิมพ์เอง */
async function captionImageAI(dataUrl) {
 // In strict mode choose the first available route and never cascade into a
 // second paid caption request after a failure.
 if (getCfg().singleRequestMode !== false) {
  ppDetect();
  if (PP_CAP.multimodal) return await ppCaptionViaContext(dataUrl);
  if (typeof window.getMultimodalCaption === 'function') return await ppCaptionViaGlobal(dataUrl);
  if (PP_CAP.slash) return await ppCaptionViaSlash();
  return '';
 }
 let cap = await ppCaptionViaContext(dataUrl);
 if (cap) return cap;
 cap = await ppCaptionViaGlobal(dataUrl);
 if (cap) return cap;
 cap = await ppCaptionViaSlash();
 if (cap) return cap;
 return '';
}

// ══════════════════════════════════════════════════════════
// โน้ต / สตอรี่ / ฟีด helpers
// ══════════════════════════════════════════════════════════
const NOTE_TTL = 24 * 3600000;
const STORY_TTL = 24 * 3600000;

function getUserNote() { const n = getCfg().userNote; if (!n || !n.text) return null; if (Date.now() - (n.ts || 0) > NOTE_TTL) return null; return n; }
function getBotNote(cid) { const n = (getCfg().botNotes || {})[cid]; if (!n || !n.text) return null; if (Date.now() - (n.ts || 0) > NOTE_TTL) return null; return n; }
function setUserNote(text) {
 const cfg = getCfg();
 cfg.userNote = text ? { text: String(text).slice(0, 120), ts: Date.now() } : null;
 saveCfg();
 ppLog('note', text ? `ตั้งสเตตัสว่า "${String(text).slice(0, 120)}"` : 'ลบสเตตัสของตัวเอง');
}
function setBotNote(cid, text) {
 const cfg = getCfg();
 if (!cfg.botNotes) cfg.botNotes = {};
 if (text) cfg.botNotes[cid] = { text: String(text).slice(0, 120), ts: Date.now() };
 else delete cfg.botNotes[cid];
 saveCfg();
}

function getStories() { return getCfg().stories || []; }
function liveStories() { const now = Date.now(); return getStories().filter(s => now - (s.ts || 0) < STORY_TTL); }
function pruneStories() {
 const cfg = getCfg(), now = Date.now(), before = (cfg.stories || []).length;
 const keep = new Set();
 (cfg.storyHighlights || []).forEach(h => (h.storyIds || []).forEach(id => keep.add(id)));
 cfg.stories = (cfg.stories || []).filter(s => keep.has(s.id) || now - (s.ts || 0) < STORY_TTL);
 for (const id of Object.keys(cfg.storySeen || {})) if (!cfg.stories.find(s => s.id === id)) delete cfg.storySeen[id];
 if (cfg.stories.length !== before) saveCfg();
}
function storyAuthorLabel(s) { if (s.author === 'user') return getUserDisplayName(); const c = findContact(s.author); return c ? dname(c) : (s.authorName || '?'); }
function markStorySeen(id) { const cfg = getCfg(); if (!cfg.storySeen) cfg.storySeen = {}; if (!cfg.storySeen[id]) { cfg.storySeen[id] = true; saveCfg(); } }
function storyHasUnseen(author) { return liveStories().some(s => s.author === author && !(getCfg().storySeen || {})[s.id]); }

function postTotalLikes(p) { return (p.extraLikes || 0) + ((p.likes || []).length); }
function commentTotalLikes(cm) { return (cm.extraLikes || 0) + ((cm.likes || []).length); }
function topFeedPosts(n) { return getFeedPosts().filter(p => p.kind !== 'news').slice().sort((a, b) => postTotalLikes(b) - postTotalLikes(a)).slice(0, n || 5); }
function postAuthorLabel(p) {
 if (p.author === 'user') return getUserDisplayName();
 if (p.handle) return p.handle;
 const c = findContact(p.author);
 return c ? dname(c) : (p.authorName || 'ระบบ');
}
function commentAuthorLabel(cm) {
 if (cm.author === 'user') return getUserDisplayName();
 if (cm.ghost) return cm.authorName || cm.handle || 'ใครไม่รู้';
 if (cm.handle) return cm.handle;
 const c = findContact(cm.author);
 return c ? dname(c) : (cm.authorName || '?');
}
function makeHandle(name) {
 const tags = ['เอง', 'บี๋', '_official', 'อ่ะ', 'จ้า', '.x', '_ig', 'ครับผม', 'นะจ๊ะ', '._.'];
 return name + tags[Math.floor(Math.random() * tags.length)];
}
function extractHashtags(text) {
 const out = [];
 const rx = /#([^\s#.,!?]{1,30})/g;
 let m;
 while ((m = rx.exec(String(text || '')))) out.push(m[1]);
 return [...new Set(out)];
}
function isSaved(pid) { return (getCfg().savedPosts || []).includes(pid); }
function isPostArchived(pid) { return (getCfg().archivedPosts || []).includes(pid); }

/** ใครมองเห็นโพสต์นี้ได้ (ใช้เลือก pool ผู้ตอบ) */
function postAudience(p) {
 const cfg = getCfg();
 const vis = (p && p.visibility) || cfg.postVisibilityDefault || 'all';
 let pool = getContacts().filter(c => !isBlocked(c.id) && !isRestricted(c.id));
 if (cfg.universeAffectsRP) pool = pool.filter(c => c.id !== currentCharacterId());
 if (vis === 'none') return [];
 if (cfg.accountLocked) pool = pool.filter(c => (cfg.followers || []).includes(c.id));
 if (vis === 'followers') pool = pool.filter(c => (cfg.followers || []).includes(c.id));
 if (vis === 'close') pool = pool.filter(c => (cfg.closeFriends || []).includes(c.id));
 if (vis === 'selected' && Array.isArray(p.allowed)) pool = pool.filter(c => p.allowed.includes(c.id));
 if (p && Array.isArray(p.responders) && p.responders.length) pool = pool.filter(c => p.responders.includes(c.id));
 return pool;
}
function visibilityLabel(v) {
 return ({ all: 'ทุกคน', followers: 'ผู้ติดตาม', close: 'เพื่อนสนิท', selected: 'เลือกรายคน', none: 'ไม่ให้ใครเห็น' })[v] || 'ทุกคน';
}
function isFollower(cid) { return (getCfg().followers || []).includes(cid); }
function isFollowing(cid) { return (getCfg().following || []).includes(cid); }
function isCloseFriend(cid) { return (getCfg().closeFriends || []).includes(cid); }

// ── Wallet helpers ──
// ══════════════════════════════════════════════════════════
// ★ 1.0.0 WALLET PER-ROUTE — กระเป๋าเงินแยกตามแชท ST
// ══════════════════════════════════════════════════════════
function walletRouteKey() {
 const cid = currentCharacterId();
 if (!cid) return 'global';
 const chat = ppStChatId();
 return chat ? `${cid}::${chat}` : String(cid);
}
function walletRoute() {
 const cfg = getCfg();
 if (!cfg.walletPerChat) return null;
 const k = walletRouteKey();
 if (!cfg.walletRoutes[k]) {
  cfg.walletRoutes[k] = {
   balance: Math.round(cfg.walletBalance || 0),
   history: [],
   botWallets: {},
  };
  saveCfg();
 }
 const r = cfg.walletRoutes[k];
 if (!Array.isArray(r.history)) r.history = [];
 if (!r.botWallets || typeof r.botWallets !== 'object') r.botWallets = {};
 return r;
}
function walletBalanceGet() {
 const r = walletRoute();
 return r ? (r.balance || 0) : (getCfg().walletBalance || 0);
}
function walletBalanceSet(v) {
 const n = Math.max(0, Math.round(v));
 const r = walletRoute();
 if (r) r.balance = n; else getCfg().walletBalance = n;
 saveCfg();
}
function walletHistoryArr() {
 const r = walletRoute();
 if (r) return r.history;
 const cfg = getCfg();
 if (!cfg.walletHistory) cfg.walletHistory = [];
 return cfg.walletHistory;
}
function walletBotMap() {
 const r = walletRoute();
 if (r) return r.botWallets;
 const cfg = getCfg();
 if (!cfg.botWallets) cfg.botWallets = {};
 return cfg.botWallets;
}

function ensureWalletAccount() {
 const cfg = getCfg();
 if (!cfg.walletAccount) {
 cfg.walletAccount = Array.from({ length: 3 }, () => String(Math.floor(1000 + Math.random() * 9000))).join('-');
 saveCfg();
 }
 return cfg.walletAccount;
}
function walletName() { const cfg = getCfg(); return (cfg.walletName && cfg.walletName.trim()) || getUserDisplayName(); }
function getBotWallet(cid) {
 const map = walletBotMap();
 if (map[cid] === undefined) { map[cid] = BOT_WALLET_DEFAULT; saveCfg(); }
 return map[cid];
}
function setBotWallet(cid, amount) { const map = walletBotMap(); map[cid] = Math.max(0, Math.round(amount)); saveCfg(); }
function pushWalletHistory(dir, amount, cid, name, note) {
 const arr = walletHistoryArr();
 arr.push({ id: newId(), dir, amount: Math.round(amount), cid: cid || null, name: name || '', note: note || '', ts: Date.now() });
 if (arr.length > 200) { const keep = arr.slice(-200); arr.length = 0; Array.prototype.push.apply(arr, keep); }
 saveCfg();
}
function adjustUserBalance(delta) {
 walletBalanceSet(walletBalanceGet() + delta);
}
function spentToday() {
 const start = new Date(); start.setHours(0, 0, 0, 0);
 return walletHistoryArr().filter(h => h.dir === 'out' && h.ts >= start.getTime())
 .reduce((s, h) => s + (h.amount || 0), 0);
}
function walletDaysBuckets(days) {
 const _hist = walletHistoryArr();
 const out = [];
 for (let i = (days || 7) - 1; i >= 0; i--) {
 const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - i);
 const s = d.getTime(), e = s + 86400000;
 const rows = _hist.filter(h => h.ts >= s && h.ts < e);
 out.push({
 label: TH_DAYS[d.getDay()], date: ymd(d),
 inSum: rows.filter(r => r.dir === 'in').reduce((a, r) => a + r.amount, 0),
 outSum: rows.filter(r => r.dir === 'out').reduce((a, r) => a + r.amount, 0),
 });
 }
 return out;
}

// ══════════════════════════════════════════════════════════
// ★ 1.0.0 GHOST & CLOUT — ผู้ติดตามผี · ยอดฟอลขึ้นลงตามโพสต์
// ไม่ยิง API เพิ่มแม้แต่ครั้งเดียว — ทุกอย่างเกาะผลเจนที่มีอยู่แล้ว
// ══════════════════════════════════════════════════════════
const GHOST_SURNAME = ['ฟ้า', 'มิ้น', 'บีม', 'ปอ', 'ตาล', 'กิ๊ฟ', 'นิว', 'เจ', 'ปลื้ม', 'หมิว', 'ต้น', 'ใบเฟิร์น', 'ข้าวปั้น', 'โฟม', 'เค้ก'];
const GHOST_TAIL = ['_xx', 'jaa', '.zz', '2547', 'ff', '_official', 'nn', '_th', '.mp4', 'zaa'];

/** ผีเปิดใช้ได้ไหม — ล็อคแอค = ผีหายหมด */
function ghostOn() {
 const cfg = getCfg();
 if (cfg.dramaEnabled === false) return false; // ★ 1.3.0 ปิดระบบดราม่าทั้งชุด
 if (cfg.accountLocked) return false;
 return cfg.ghostEnabled !== false;
}
function ghostCount() { return Math.max(0, Math.round(getCfg().ghostFollowers || 0)); }
/** ยอดฟอลรวมที่โชว์ = คอนแทกต์จริง + ผี */
function totalFollowerCount() {
 return (getCfg().followers || []).length + (ghostOn() ? ghostCount() : 0);
}
/** สร้างชื่อผีในเครื่อง (ศูนย์โทเคน) */
function ghostMakeName() {
 const cfg = getCfg();
 const cached = cfg.ghostViewerNames || [];
 if (cached.length && Math.random() < 0.45) return cached[Math.floor(Math.random() * cached.length)];
 const base = GHOST_SURNAME[Math.floor(Math.random() * GHOST_SURNAME.length)];
 const tail = Math.random() < 0.6 ? GHOST_TAIL[Math.floor(Math.random() * GHOST_TAIL.length)] : '';
 return base + tail;
}
/** จำชื่อผีที่โมเดลตั้งมา ใช้ซ้ำได้ ไม่ต้องยิงใหม่ */
function ghostRememberName(name) {
 if (!name) return;
 const cfg = getCfg();
 if (!Array.isArray(cfg.ghostViewerNames)) cfg.ghostViewerNames = [];
 if (cfg.ghostViewerNames.includes(name)) return;
 cfg.ghostViewerNames.push(name);
 if (cfg.ghostViewerNames.length > 40) cfg.ghostViewerNames = cfg.ghostViewerNames.slice(-40);
}
/** ผีบางคนกลับมาซ้ำจนเป็นแฟนคลับประจำ */
function ghostPromoteRegular(name, handle) {
 if (!name) return;
 const cfg = getCfg();
 if (!Array.isArray(cfg.ghostRegulars)) cfg.ghostRegulars = [];
 if (cfg.ghostRegulars.find(x => x.name === name)) return;
 if (cfg.ghostRegulars.length >= 8) cfg.ghostRegulars.shift();
 cfg.ghostRegulars.push({ name, handle: handle || name });
 saveCfg();
}
function ghostPickRegular() {
 const arr = getCfg().ghostRegulars || [];
 if (!arr.length) return null;
 return arr[Math.floor(Math.random() * arr.length)];
}
/** บันทึกยอดฟอลขึ้น/ลง */
function cloutApply(delta, reason) {
 const cfg = getCfg();
 const d = Math.round(delta);
 if (!d) return 0;
 cfg.ghostFollowers = Math.max(0, Math.round((cfg.ghostFollowers || 0) + d));
 if (!Array.isArray(cfg.ghostFollowHistory)) cfg.ghostFollowHistory = [];
 cfg.ghostFollowHistory.push({ ts: Date.now(), delta: d, reason: String(reason || '').slice(0, 90) });
 if (cfg.ghostFollowHistory.length > 60) cfg.ghostFollowHistory = cfg.ghostFollowHistory.slice(-60);
 saveCfg();
 return d;
}
function cloudWeekDelta() {
 const since = Date.now() - 7 * 86400000;
 return (getCfg().ghostFollowHistory || []).filter(h => h.ts >= since).reduce((a, h) => a + h.delta, 0);
}
/** จำนวนโพสต์ของผู้ใช้ใน 24 ชม. — ใช้คิดโบนัสความขยัน */
function userPostsLast24h() {
 const since = Date.now() - 86400000;
 return getFeedPosts().filter(p => p.author === 'user' && (p.ts || 0) >= since).length;
}
/** สเกลไลค์ตามฐานผู้ติดตาม (ยิ่งดังยิ่งไลค์เยอะ) */
function cloutLikeScale() {
 const f = totalFollowerCount();
 if (f < 20) return 1;
 if (f < 100) return 1 + f / 90;
 if (f < 800) return 2 + f / 260;
 return 5 + Math.min(28, f / 420);
}
/**
 * ★ หัวใจ: ประมวลผลคำตัดสินของโมเดลต่อโพสต์หนึ่งชิ้น
 * verdict = { tone:'good'|'mid'|'bad', heat:0-3, note:'' }
 * คืนสรุปเป็นข้อความไทยไว้ยิง ppLog + toast
 */
function cloutJudgePost(p, verdict) {
 if (!p || !verdict) return null;
 const cfg = getCfg();
 if (p.judged) return null;
 const tone = verdict.tone === 'good' ? 'good' : verdict.tone === 'bad' ? 'bad' : 'mid';
 const heat = Math.max(0, Math.min(3, Math.round(verdict.heat || 0)));
 const drama = cfg.dramaLevel || 'normal';
 const dramaMul = drama === 'spicy' ? 1.7 : drama === 'calm' ? 0.5 : 1;
 const base = Math.max(4, Math.round(totalFollowerCount() * 0.05) + 6);
 const diligence = Math.min(3, userPostsLast24h()); // โพสต์บ่อยมีโบนัส แต่ไม่บวกฟรี

 let delta = 0;
 if (tone === 'good') delta = Math.round((base + diligence * 3) * (1 + heat * 0.35));
 else if (tone === 'mid') delta = Math.round(base * 0.25) + diligence;
 else delta = -Math.round((base * 0.9 + heat * base * 0.8) * dramaMul);

 // ดราม่าแรงแต่โพสต์ดี = ยังได้คนตามเพิ่มแบบกระโดด
 if (tone === 'good' && heat >= 2) delta += Math.round(base * 0.8 * dramaMul);
 // โพสต์บ่อยเกินแต่คุณภาพกลาง ๆ = คนเริ่มรำคาญ
 if (tone === 'mid' && userPostsLast24h() >= 5) delta -= Math.round(base * 0.4);

 delta += Math.round((Math.random() - 0.45) * base * 0.5);
 const applied = cloutApply(delta, `${tone}/heat${heat} — ${(p.text || '[รูป]').slice(0, 40)}`);

 p.judged = true;
 p.tone = tone;
 p.heat = heat;
 p.extraLikes = (p.extraLikes || 0) + Math.max(0, Math.round(
  (tone === 'good' ? 14 : tone === 'mid' ? 5 : 2) * cloutLikeScale() * (1 + heat * 0.5)
 ));
 saveCfg();

 const toneTh = tone === 'good' ? 'คนชอบ' : tone === 'bad' ? 'คนไม่ชอบ' : 'เฉย ๆ';
 const heatTh = heat >= 3 ? 'ดราม่าเดือด' : heat === 2 ? 'มีคนเถียงกัน' : heat === 1 ? 'มีคนแซะเบา ๆ' : 'ไม่มีดราม่า';
 return {
  applied, tone, heat,
  summary: `กระแสโพสต์: ${toneTh} · ${heatTh} · ผู้ติดตาม ${applied >= 0 ? '+' : ''}${applied} (รวม ${totalFollowerCount()})`,
 };
}
/** สุ่มว่าผีจะทักแชทจริงไหม (ค่าเริ่มต้น 2%) */
function ghostMaybeDm(seedName) {
 if (!ghostOn()) return null;
 const cfg = getCfg();
 const chance = Math.max(0, Math.min(5, cfg.ghostDmChance == null ? 2 : cfg.ghostDmChance));
 if (Math.random() * 100 >= chance) return null;
 const name = seedName || ghostMakeName();
 const npc = { id: 'ghost:' + newId(), name, avatar: '', npc: true, ghost: true, ownerCharId: currentCharacterId() || '' };
 cfg.contacts.push(npc);
 saveCfg();
 return npc;
}
/** ผีแอบดูสตอรี่ — ศูนย์โทเคน */
function ghostHauntStory(story) {
 if (!ghostOn() || !story) return 0;
 const n = Math.min(9, Math.round(Math.random() * Math.max(1, Math.sqrt(totalFollowerCount()))));
 if (!n) return 0;
 story.views = story.views || {};
 for (let i = 0; i < n; i++) {
  const reg = Math.random() < 0.3 ? ghostPickRegular() : null;
  const nm = reg ? reg.name : ghostMakeName();
  story.views['ghost:' + nm] = Date.now();
  if (Math.random() < 0.25) { story.likes = story.likes || []; story.likes.push('ghost:' + nm); }
 }
 saveCfg();
 return n;
}
/** แกะบล็อก [CLOUT] ... จากคำตอบโมเดล */
function parseCloutBlock(raw) {
 const m = String(raw || '').match(/\[CLOUT\]\s*([a-z]+)\s*\|\s*(\d)\s*(?:\|\s*([^\n\]]*))?/i);
 if (!m) return null;
 return { tone: m[1].toLowerCase(), heat: parseInt(m[2], 10) || 0, note: (m[3] || '').trim() };
}
/** แกะคอมเมนต์ผี [GHOST]ชื่อ|N "ข้อความ" */
function parseGhostComments(raw) {
 const out = [];
 const rx = /\[GHOST\]\s*([^\|\]\n]{1,24})\s*\|?\s*(\d*)\s*\]?\s*(.+)$/gim;
 let m;
 while ((m = rx.exec(String(raw || '')))) {
  const name = stripEmoji(m[1].trim());
  const likes = parseInt(m[2] || '0', 10) || 0;
  const q = extractSpoken(m[3]);
  const text = q.length ? q[0] : stripEmoji(cleanReply(m[3]).replace(/^["'“”‘’„«»「」『』]+|["'“”‘’„«»「」『』]+$/g, '')).trim();
  if (name && text && !looksLikeThought(text)) out.push({ name, text, likes });
 }
 return out;
}

// ══════════════════════════════════════════════════════════
// ★ 1.0.0 MENTION — แท็กกันไปกลับ
// ══════════════════════════════════════════════════════════
function extractMentions(text) {
 const out = [];
 const rx = /@([^\s@#.,!?]{1,30})/g;
 let m;
 while ((m = rx.exec(String(text || '')))) out.push(m[1]);
 return [...new Set(out)];
}
function resolveMention(handleOrName) {
 const s = String(handleOrName || '').toLowerCase().replace(/^@/, '');
 if (!s) return null;
 if (s === getUserHandle().toLowerCase() || s === getUserDisplayName().toLowerCase()) return { user: true };
 const c = getContacts().find(x => dname(x).toLowerCase() === s)
  || getContacts().find(x => dname(x).toLowerCase().replace(/\s+/g, '') === s.replace(/\s+/g, ''))
  || getContacts().find(x => s.includes(dname(x).toLowerCase()));
 return c ? { contact: c } : null;
}
function pushMention(pid, cid, text) {
 const cfg = getCfg();
 if (!Array.isArray(cfg.mentionsInbox)) cfg.mentionsInbox = [];
 cfg.mentionsInbox.push({ id: newId(), pid, cid, text: String(text || '').slice(0, 140), ts: Date.now(), seen: false });
 if (cfg.mentionsInbox.length > 60) cfg.mentionsInbox = cfg.mentionsInbox.slice(-60);
 saveCfg();
}
function unseenMentions() { return (getCfg().mentionsInbox || []).filter(x => !x.seen).length; }

// ══════════════════════════════════════════════════════════
// ★ 1.0.0 REPOST
// ══════════════════════════════════════════════════════════
function rootPost(p) {
 let cur = p, guard = 0;
 while (cur && cur.repostOf && guard++ < 6) {
  const nxt = findPost(cur.repostOf);
  if (!nxt) break;
  cur = nxt;
 }
 return cur || p;
}
function repostCount(pid) { return getFeedPosts().filter(p => p.repostOf === pid).length; }
function userReposted(pid) { return getFeedPosts().some(p => p.repostOf === pid && p.author === 'user'); }
function doRepost(pid, quote) {
 const src = findPost(pid);
 if (!src) return null;
 const root = rootPost(src);
 const cfg = getCfg();
 const np = {
  id: newId(), author: 'user', kind: 'post',
  repostOf: root.id, quote: (quote || '').slice(0, 400),
  text: '', mediaKeys: [], captions: [],
  visibility: cfg.postVisibilityDefault || 'all',
  ts: Date.now(), likes: [], extraLikes: 0, comments: [], views: {}, saves: 0,
 };
 cfg.feedPosts.push(np);
 saveCfg();
 return np;
}

// ── notif / unread ──
function pushNotif(cid, kind, text, extra) {
 const cfg = getCfg();
 if (!cfg.notifCenter) cfg.notifCenter = [];
 cfg.notifCenter.push(Object.assign({ id: newId(), cid, kind, text: String(text || '').slice(0, 120), ts: Date.now(), seen: false }, extra || {}));
 if (cfg.notifCenter.length > 120) cfg.notifCenter = cfg.notifCenter.slice(-120);
 saveCfg();
}
function unreadNotifCount() { return (getCfg().notifCenter || []).filter(n => !n.seen).length; }
function bumpUnread(tid, n) {
 const cfg = getCfg();
 if (!cfg.unread) cfg.unread = {};
 const key = threadKey(tid);
 cfg.unread[key] = Math.max(0, (cfg.unread[key] || 0) + (n == null ? 1 : n));
 saveCfg();
}
function clearUnread(tid) {
 const cfg = getCfg();
 if (!cfg.unread) return;
 const key = threadKey(tid);
 const prefix = tid + '::';
 let changed = false;
 for (const k of Object.keys(cfg.unread)) {
 if (k === key || k === tid || k.startsWith(prefix)) { delete cfg.unread[k]; changed = true; }
 }
 if (changed) saveCfg();
}
function unreadOf(tid) {
 const u = getCfg().unread || {};
 const key = threadKey(tid);
 if (u[key]) return u[key];
 // fallback: รวม unread ทุกรูทของ contact นี้ (กัน key ไม่ตรงเพราะ chatId เปลี่ยน/ว่าง)
 let sum = 0;
 const prefix = tid + '::';
 for (const k in u) { if (k === tid || k.startsWith(prefix)) sum += (u[k] || 0); }
 return sum;
}

// ── persona ──
function listUserPersonas() {
 const c = ctx();
 try {
 const pu = c && c.powerUserSettings;
 const map = pu && pu.personas;
 const desc = (pu && pu.persona_descriptions) || {};
 if (map && typeof map === 'object') {
 return Object.keys(map).map(av => ({
 id: av, name: map[av] || av, avatar: `/User Avatars/${av}`,
 description: (desc[av] && desc[av].description) || '',
 }));
 }
 } catch {}
 return [];
}
function currentUserPersonaId() {
 const c = ctx();
 try {
 if (c) {
 if (c.userAvatar) return c.userAvatar;
 if (c.user_avatar) return c.user_avatar;
 const pa = c.powerUserSettings?.persona_description_avatar;
 if (pa) return pa;
 }
 } catch {}
 return '';
}
/** ★ ไม่มี vanish · ไม่มี showRel */
function getChatStyle(id) {
 const cfg = getCfg();
 if (!cfg.chatStyle[id]) cfg.chatStyle[id] = {};
 const s = cfg.chatStyle[id];
 const d = {
 bg: '', bubble: '', bubbleImg: false, textColor: '',
 personaName: '', personaDesc: '', userPersonaId: '',
 ringtone: '', bubbleGlass: false, tail: 'round',
 stickerPack: '', msgBlur: 0,
 };
 for (const k of Object.keys(d)) if (s[k] === undefined) s[k] = d[k];
 if (s.vanish !== undefined) delete s.vanish;
 if (s.showRel !== undefined) delete s.showRel;
 return s;
}
function getEffectiveUserPersona(id) {
 const cfg = getCfg();
 let pid;
 if (cfg.userPersonaMode === 'shared') pid = cfg.sharedUserPersonaId || currentUserPersonaId();
 else pid = getChatStyle(id).userPersonaId || cfg.sharedUserPersonaId || currentUserPersonaId();
 const p = listUserPersonas().find(x => x.id === pid);
 if (p) return { name: p.name, desc: p.description };
 const c = ctx();
 let desc = '';
 try { desc = (c && c.powerUserSettings && c.powerUserSettings.persona_description) || ''; } catch {}
 return { name: getUserDisplayName(), desc };
}
function listStCharacters() {
 const c = ctx();
 if (c && Array.isArray(c.characters) && c.characters.length) {
 return c.characters.filter(ch => ch && ch.name && !ch.is_user)
 .map(ch => ({ id: ch.avatar || ch.name, name: ch.name, avatar: ch.avatar ? `/characters/${ch.avatar}` : '', persona: ch.description || ch.personality || '' }));
 }
 return [];
}
// ── Lorebook (world info) ──
function ppListLorebooks() {
 const c = ctx();
 try { if (c && typeof c.getWorldInfoNames === 'function') { const n = c.getWorldInfoNames(); if (Array.isArray(n)) return n; } } catch (e) { console.warn('[pocket-phone] getWorldInfoNames', e); }
 return [];
}
async function ppLoadLoreEntries(bookName) {
 const c = ctx();
 if (!bookName) return [];
 try {
 if (!c || typeof c.loadWorldInfo !== 'function') return [];
 const book = await c.loadWorldInfo(bookName);
 const ent = book && book.entries;
 if (!ent) return [];
 const arr = Array.isArray(ent) ? ent : Object.keys(ent).map(k => ent[k]);
 return arr.filter(Boolean).map(e => ({
 uid: String(e.uid != null ? e.uid : ''),
 title: String(e.comment || (Array.isArray(e.key) ? e.key.join(', ') : '') || 'ไม่มีชื่อ').slice(0, 60),
 content: String(e.content || ''),
 disabled: !!e.disable,
 })).filter(e => e.content);
 } catch (e) { console.warn('[pocket-phone] loadWorldInfo', e); return []; }
}
// ดึงเนื้อหา lore ที่ผูกกับ contact นี้ (cache ไว้ในคอนแทกต์ กันโหลดซ้ำทุกครั้งที่เจน)
async function ppFetchLoreForContact(cid) {
 const c = findContact(cid);
 if (!c || !c.loreBook) return '';
 const entries = await ppLoadLoreEntries(c.loreBook);
 if (!entries.length) return '';
 const pick = Array.isArray(c.loreUids) && c.loreUids.length
 ? entries.filter(e => c.loreUids.includes(e.uid))
 : entries; // ไม่เลือก uid = ใช้ทั้งเล่ม
 const txt = pick.map(e => `[${e.title}] ${e.content}`).join('\n').slice(0, 2000);
 c.loreCache = txt;
 saveCfg();
 return txt;
}
function getContactPersona(id) { const ch = listStCharacters().find(x => x.id === id); return ch ? (ch.persona || '') : ''; }
function getEffectivePersona(id) {
 const CAP = 1500; // กันการ์ดใหญ่ยัดเป็นหมื่นโทเคน
 const st = getChatStyle(id);
 const parts = [];
 if (st.personaName) parts.push(`Name: ${st.personaName}`);
 if (st.personaDesc) parts.push(st.personaDesc);
 if (parts.length) return parts.join('\n').slice(0, CAP);
 const c = findContact(id);
 if (c && c.customNpc) {
 const bits = [];
 if (c.npcDesc) bits.push(c.npcDesc);
 if (c.loreCache) bits.push(`Lore: ${c.loreCache}`);
 if (c.useBaseContext && c.baseCharId) {
 const base = getContactPersona(c.baseCharId);
 if (base) bits.push(`Ref from ${listStCharacters().find(x => x.id === c.baseCharId)?.name || 'main'} (only what fits): ${base}`);
 }
 return bits.join('\n').slice(0, CAP);
 }
 return String(getContactPersona(id) || '').slice(0, CAP);
}
function mainChatRecap(maxLines) {
 const c = ctx();
 try {
 if (c && Array.isArray(c.chat) && c.chat.length) {
 const lines = c.chat.slice(-(maxLines || 14)).map(m => {
 const who = m.is_user ? getUserDisplayName() : (m.name || 'Char');
 const txt = String(m.mes || '')
 .replace(PP_MARK_RX, '').replace(PP_HIDDEN_RX, '')
 .replace(/\[PP_(?:CALL|MSG|NEWCHAT|PAY|EARN|FOLLOW):[^\]]*\]/gi, '')
 .replace(/<[^>]+>/g, '').replace(/\n+/g, ' ').trim();
 return txt ? `${who}: ${txt.slice(0, 320)}` : '';
 }).filter(Boolean);
 return lines.join('\n');
 }
 } catch {}
 return '';
}

// ── สติกเกอร์ ──
function getStickerPacks() { return getCfg().stickerPacks || []; }
function findStickerPack(id) { return getStickerPacks().find(p => p.id === id) || null; }
function allStickers() {
 const out = [];
 getStickerPacks().forEach(p => (p.items || []).forEach(it => out.push({ ...it, pack: p.name, packId: p.id })));
 return out;
}
function findStickerByLabel(label) {
 if (!label) return null;
 const s = String(label).trim().toLowerCase();
 return allStickers().find(x => String(x.label || '').trim().toLowerCase() === s)
 || allStickers().find(x => String(x.label || '').toLowerCase().includes(s)) || null;
}
function stickerPromptList() {
 const arr = allStickers().filter(x => x.label);
 if (!arr.length) return '';
 return arr.slice(0, 30).map(x => x.label).join(', ');
}

// ── diag / เครื่องมือ ──
window.PP_STRIP_ALL = ppStripAll;
window.PP_PREVIEW_LOG = () => { const s = ppPreviewLog(); console.log(s); return s; };
window.PP_LOG_COUNT = ppLogCount;
window.PP_STAMP_NOW = ppStampUserMessage;
window.PP_DIAG = function () {
 const cap = ppDetect(true);
 const cfg = getCfg();
 const rows = {
 version: PP_VERSION, loaded: window.PP_LOADED,
 '-- API --': '',
 ctx: cap.ctx, chatArray: cap.chat,
 generateQuietPrompt: cap.genQuiet, stopGeneration: cap.stopGen,
 setExtensionPrompt: cap.setExtPrompt, messageFormatting: cap.msgFormat,
 saveChatDebounced: cap.saveDebounced, saveChat: cap.saveChat,
 getMultimodalCaption: cap.multimodal, slashCommands: cap.slash,
 captionExtInDOM: cap.captionExt, localforage: cap.localforage,
 msgEvents: (cap.msgEvents || []).join(','),
 '-- TOKENS (quiet prompt) --': '',
 tokenizer: (cap.ctx && (typeof ctx().getTokenCountAsync === 'function' || typeof window.getTokenCountAsync === 'function')) ? 'พบ' : 'ไม่พบ',
 lastPromptTokens: ppTokenStats.lastPrompt, lastResponseTokens: ppTokenStats.lastResponse,
 lastTotalTokens: ppTokenStats.lastTotal, sessionTotalTokens: ppTokenStats.sessionTotal, genCount: ppTokenStats.count,
 '-- ACTION LOG --': '',
 logToStory: cfg.logToStory, wrapMode: cfg.logWrapMode,
 logMinor: cfg.logMinorActions,
 queued: ppLogCount(), stamps: (cfg.logStamps || []).length,
 '-- ONE-REQUEST SYNC (1.1.0) --': '',
 singleRequestMode: cfg.singleRequestMode !== false,
 autoSyncEnabled: cfg.autoSyncEnabled !== false,
 syncMaxEvents: cfg.syncMaxEvents || 8,
 lastSync: ppSyncReceiptLabel(cfg.lastSyncReceipt),
 syncTurns: (cfg.syncStats || {}).turns || 0,
 syncAppliedTurns: (cfg.syncStats || {}).applied || 0,
 syncMissingTurns: (cfg.syncStats || {}).missing || 0,
 syncInvalidTurns: (cfg.syncStats || {}).invalid || 0,
 '-- DATA --': '',
 contacts: getContacts().length, groups: getGroups().length,
 threads: Object.keys(cfg.threads || {}).length,
 posts: getFeedPosts().length, stories: liveStories().length,
 stickers: allStickers().length,
 starred: Object.values(cfg.starred || {}).reduce((a, b) => a + b.length, 0),
 walletBal: cfg.walletBalance, periodDays: getPeriodDays().length,
 followers: (cfg.followers || []).length, locked: cfg.accountLocked,
 '-- CLOUT (1.0.0) --': '',
 ghostOn: ghostOn(), ghostFollowers: ghostCount(), totalFollowers: totalFollowerCount(),
 week7d: cloudWeekDelta(), drama: cfg.dramaLevel, ghostDmChance: cfg.ghostDmChance,
 ghostRegulars: (cfg.ghostRegulars || []).length, mentionsUnseen: unseenMentions(),
 reposts: getFeedPosts().filter(p => p.repostOf).length,
 newsItems: getFeedPosts().filter(p => p.kind === 'news').length,
 walletPerChat: cfg.walletPerChat, walletRoute: walletRouteKey(),
 genQueue: ppGenQueue.length, stGenBusy: ppStGenBusy, ownGenBusy: ppOwnGenBusy,
 };
 console.table(rows);
 console.log('ตัวอย่างบล็อกที่จะแทรก:\n' + ppPreviewLog());
 if (typeof ppToast === 'function') ppToast('Diag ไปที่ console แล้ว');
 return rows;
};
// ══════════════════════════════════════════════════════════
// ★ 1.3.0 BRIDGE MODULES — เปิด/ปิดรายอัน + วัดโทเคนจริงด้วย tokenizer ของ ST
// ══════════════════════════════════════════════════════════
function bridgeOn(key) {
 try { const m = getCfg().bridgeMods || {}; return m[key] !== false && m[key] !== undefined ? !!m[key] : false; }
 catch { return false; }
}
const BRIDGE_MOD_META = [
 { key: 'msg',       label: 'ข้อความ / แชท',        group: 'events', hint: 'dm · เสียง · สติกเกอร์ · ตำแหน่ง · ของขวัญ · ยกเลิกข้อความ · ตอบสตอรี่' },
 { key: 'groupcall', label: 'กลุ่ม + โทรศัพท์',      group: 'events', hint: 'แชทกลุ่ม · สายเข้า · สายที่ไม่ได้รับ · บันทึกสาย' },
 { key: 'feed',      label: 'ฟีด / โพสต์ / คอมเมนต์', group: 'events', hint: 'โพสต์ · คอมเมนต์ · ไลก์ · บันทึก · รีโพสต์ · โพล' },
 { key: 'story',     label: 'สตอรี่',               group: 'events', hint: 'ลงสตอรี่ · ถูกใจสตอรี่' },
 { key: 'wallet',    label: 'กระเป๋าเงิน',          group: 'events', hint: 'โอนเข้า/ออก · ขอเงิน' },
 { key: 'social',    label: 'ติดตาม / สเตตัส',      group: 'events', hint: 'ขอติดตาม · เลิกติดตาม · บอทลงสเตตัสเอง' },
 { key: 'news',      label: 'ข่าว',                 group: 'events', hint: 'ข่าวในโลกเรื่อง เด้งเข้าแอปข่าว' },
 { key: 'inv_contacts', label: 'รายชื่อคอนแทกต์',    group: 'inv',    hint: 'ช่วยให้บอทสะกดชื่อถูก — ตั้งจำนวนได้ด้านล่าง' },
 { key: 'inv_stickers', label: 'รายชื่อป้ายสติกเกอร์', group: 'inv',  hint: 'ให้บอทเลือกสติกเกอร์ที่คุณมีจริง ปิดแล้วบอทจะเดาชื่อผิด' },
 { key: 'inv_posts',    label: 'โพสต์ / สตอรี่ล่าสุด', group: 'inv',  hint: 'ให้บอทอ้างโพสต์เก่าได้ถูกอัน' },
 { key: 'inv_ui',       label: 'สถานะ UI มือถือ',    group: 'inv',    hint: 'ธีม สี วอลเปเปอร์ ทรงฟอง — แพงสุด ประโยชน์น้อยสุด' },
 { key: 'actionlog',    label: 'บันทึกกิจกรรมของคุณ', group: 'inv',   hint: 'สิ่งที่คุณเพิ่งทำในมือถือ — ปิดแล้วบอทจะไม่รู้เลย' },
];
/** ประกอบชิ้น prompt ตามโมดูลที่เปิด — คืน {core, mods:{key:string}, actionBody} */
/** ★ 1.4.0 เลือกคอนแทกต์ที่เกี่ยวข้องกับฉากนี้ — ไม่ยัดร้อยชื่อทุกเทิร์น */
function ppRelevantContacts(limit) {
 const cap = Math.max(1, Math.min(200, limit || 12));
 const scope = currentCharacterId();
 const scored = [];
 const week = Date.now() - 7 * 86400000;
 getContacts().forEach(c => {
  if (isBlocked(c.id)) return;
  let score = 0;
  if (c.id === scope) score += 1000;
  if (c.baseCharId === scope || c.ownerCharId === scope) score += 500;
  if (isPinned(c.id)) score += 300;
  const ts = lastTs(c.id);
  if (ts >= week) score += 200 + Math.round((ts - week) / 3600000);
  else if (ts) score += 50;
  if (unreadOf(c.id) > 0) score += 120;
  scored.push({ c, score });
 });
 scored.sort((a, b) => b.score - a.score);
 return scored.slice(0, cap).map(x => x.c);
}
/** สร้างบล็อกรายชื่อตามโหมดที่ตั้งไว้ — คืน '' ถ้าปิด */
function ppBuildContactBlock() {
 const cfg = getCfg();
 const mode = cfg.contactSendMode || 'relevant';
 if (mode === 'off') return '';
 const list = mode === 'all'
  ? getContacts().filter(c => !isBlocked(c.id))
  : ppRelevantContacts(cfg.contactSendLimit || 12);
 if (!list.length) return '';
 const names = list.map(dname);
 const groups = getGroups().slice(0, 20).map(g => `${g.name}(${groupMemberContacts(g).map(dname).join(',')})`);
 const total = getContacts().filter(c => !isBlocked(c.id)).length;
 const head = mode === 'all'
  ? `Contacts (all ${total})=${names.join(', ')}`
  : `Contacts most relevant right now (${names.length} of ${total}; other contacts exist — if you mean someone not listed, spell their name exactly as the user wrote it)=${names.join(', ')}`;
 return groups.length ? `${head}\nGroups=${groups.join('; ')}` : head;
}
/** ประกอบชิ้น prompt ตามโมดูลที่เปิด */
function ppBuildBridgeParts(actionBody) {
 const cfg = getCfg();
 const maxEv = Math.max(1, Math.min(20, cfg.syncMaxEvents || 8));
 const core = [
  `[Pocket Phone v2 one-request bridge. This is part of the SAME normal response and must never trigger or imply a second model call.]`,
  `After the normal roleplay prose, append exactly one plain data frame (not HTML, not a div, not a comment, not a code fence):`,
  `${PP_SYNC_FRAME_START}{"v":2,"events":[]}${PP_SYNC_FRAME_END}`,
  `The extension consumes and removes this frame from chat. Put every phone consequence caused, requested, or clearly implied by this turn in events. If none, use an empty array. Never mention the frame in prose.`,
  `Use valid JSON with double quotes. Maximum ${maxEv} events. Only the event types listed below are enabled — never emit a type that is not listed.`,
  `CRITICAL: whatever your prose says the character did on their phone, the frame must contain the MATCHING event type. If your prose says they sent a voice clip, emit "voice" — not "dm". If it says they sent a sticker, emit "sticker". If it says they unsent something, emit "unsend". Mismatched prose and frame means the phone shows nothing.`,
 ].join('\n');
 const mods = {};
 if (bridgeOn('msg')) {
  mods.msg = [
   `Messages — pick the type that matches what actually happened:`,
   `  dm — plain typed text. {"type":"dm","from":"Name","text":["line 1","line 2"]}`,
   `  voice — a recorded voice clip. Use this whenever the character SPEAKS instead of typing. {"type":"voice","from":"Name","text":"what they say out loud"}`,
   `  sticker — {"type":"sticker","from":"Name","label":"sticker label"}`,
   `  location — {"type":"location","from":"Name","place":"place name","note":"optional"}`,
   `  gift — {"type":"gift","from":"Name","gift":"item name"}`,
   `  poll — {"type":"poll","from":"Name","question":"?","options":["a","b"]}`,
   `  unsend — recall your own last message. It stays visible as "message unsent" and the user may or may not have read it. {"type":"unsend","from":"Name","text":"the original words","letUserPeek":true}`,
   `  story_reply — {"type":"story_reply","from":"Name","text":"reply","storyId":"optional"}`,
   `  contact — a new person saves themselves into the phone. {"type":"contact","name":"Name"}`,
   `  nickname — the character renames the user in their own phone. Fires a one-time notice. {"type":"nickname","from":"Name","text":"what they saved the user as"}`,
  ].join('\n');
 }
 if (bridgeOn('groupcall')) {
  const gp = [
   `Groups & calls:`,
   `  group — send into an existing group. {"type":"group","group":"Group Name","from":"Name","text":["line"]}`,
   `  call — a phone actually rings NOW. {"type":"call","from":"Name","live":true}`,
   `  missed_call — {"type":"missed_call","from":"Name","count":2}`,
   `  call_log — a call that already happened offscreen. {"type":"call_log","from":"Name","minutes":7,"transcript":["line","line"]}`,
  ];
  if (cfg.botCanMakeGroup) gp.push(`  group_create — create a new group and add the user to it. {"type":"group_create","group":"Group Name","members":["Name A","Name B"],"from":"Name A","text":["opening message"]}`);
  mods.groupcall = gp.join('\n');
 }
 if (bridgeOn('feed')) mods.feed = `Feed: post (author, text, likes, visibility, closeOnly, poll, question); comment / comment_reply (author, text, postId, parentId); like / unlike / save_post; repost; poll_vote (postId, option).`;
 if (bridgeOn('story')) mods.story = `Stories: story (author, text, closeOnly); story_like (from, storyId).`;
 if (bridgeOn('wallet')) {
  const w = [
   `Money:`,
   `  wallet — money actually moves. {"type":"wallet","from":"Name","direction":"in","amount":500,"reason":"why"}  (direction "in" = they pay the user, "out" = the user pays them)`,
   `  wallet_request — they ask the user for money. {"type":"wallet_request","from":"Name","amount":300,"reason":"why"}`,
  ];
  if (cfg.botCanSetWallet) w.push(`  wallet_set — declare how much money the character currently has, when the story establishes it (payday, went broke, inheritance). {"type":"wallet_set","from":"Name","amount":85000,"reason":"why"}`);
  mods.wallet = w.join('\n');
 }
 if (bridgeOn('social')) mods.social = `Social: follow; follow_request; unfollow; note (author, text) — a character posts their own 24h status note when it fits the scene.`;
 if (bridgeOn('news')) mods.news = `News: news (source, text as array of headline + body lines, likes). Use for public incidents, disasters, political decisions, or widely witnessed events only.`;
 if (bridgeOn('inv_contacts')) {
  const block = ppBuildContactBlock();
  if (block) mods.inv_contacts = block;
 }
 if (bridgeOn('inv_stickers')) {
  const sl = stickerPromptList();
  if (sl) mods.inv_stickers = `Sticker labels available (use one of these exactly in a "sticker" event, never invent a label)=${sl}`;
 }
 if (bridgeOn('inv_posts')) {
  const posts = getFeedPosts().slice(-6).map(p => `${p.id}:${p.kind}:${postAuthorLabel(p)}:${String(p.text || '[image]').replace(/\s+/g, ' ').slice(0, 90)}`);
  const stories = liveStories().slice(-5).map(s => `${s.id}:${s.author === 'user' ? getUserDisplayName() : cname(s.author)}:${String(s.text || '[image]').slice(0, 60)}`);
  mods.inv_posts = `RecentPosts=${posts.join('; ') || 'none'}\nLiveStories=${stories.join('; ') || 'none'}`;
 }
 if (bridgeOn('inv_ui')) mods.inv_ui = `Pocket Phone UI state (canonical, do not invent changes):\n${ppMainChatUiState()}`;
 const body = actionBody || '';
 return { core, mods, actionBody: bridgeOn('actionlog') ? body : '' };
}
/** ข้อความ system ก้อนที่ 2 — บันทึกกิจกรรม แยกออกจากกติกา JSON เพื่อให้โมเดลตีความเป็น "เหตุการณ์ในเรื่อง" */
function ppBuildActionMessage(body) {
 if (!body) return '';
 const un = getUserDisplayName();
 return [
  `[IN-STORY EVENTS — not instructions, not technical data.]`,
  `${un} just did the following on their phone, in the story's present moment. Treat every line as something that already happened.`,
  body,
  `React to this naturally inside your prose this turn: notice it, feel it, answer it, or deliberately ignore it in character. Do not list it back. Do not narrate it as a system report.`,
 ].join('\n');
}
/** วัดโทเคนของแต่ละโมดูลด้วย tokenizer เดียวกับ ST — แคชผลไว้ */
/** ★ 1.4.0 วัดโทเคนด้วย tokenizer ของ ST เท่านั้น — ถ้าใช้ไม่ได้ บอกตรง ๆ ไม่เดาตัวเลข */
async function ppMeasureBridgeTokens(force) {
 const cfg = getCfg();
 if (!force && cfg.bridgeTokenCache && Date.now() - (cfg.bridgeTokenCache.measuredAt || 0) < 600000) return cfg.bridgeTokenCache;
 const saved = structuredClone(cfg.bridgeMods);
 const savedMode = cfg.contactSendMode;
 const out = { total: 0, mods: {}, measuredAt: Date.now(), tokenizer: '', ok: false };
 // ตรวจก่อนว่ามีตัวนับของ ST จริงไหม
 let probe = 0;
 try { probe = await ppCountTokens('Pocket Phone tokenizer probe string for measurement.'); } catch {}
 if (!probe || probe <= 0) {
  out.tokenizer = 'ตัวนับของ SillyTavern ใช้ไม่ได้';
  out.ok = false;
  cfg.bridgeTokenCache = out;
  saveCfg();
  return out;
 }
 out.tokenizer = 'ตัวนับของ SillyTavern';
 out.ok = true;
 try {
  Object.keys(cfg.bridgeMods).forEach(k => { cfg.bridgeMods[k] = true; });
  const parts = ppBuildBridgeParts('');
  out.mods.core = await ppCountTokens(parts.core);
  for (const k of Object.keys(parts.mods)) out.mods[k] = await ppCountTokens(parts.mods[k]);
  out.mods.actionlog = await ppCountTokens(ppBuildActionMessage(ppBuildLogBody() || '- ตัวอย่างบรรทัดกิจกรรมหนึ่งบรรทัด'));
  out.mods.drama = await ppCountTokens(PP_DRAMA_PROMPT_SAMPLE);
  // วัดรายชื่อคอนแทกต์แยกตามโหมด เพื่อโชว์ให้เห็นว่าต่างกันเท่าไหร่
  cfg.contactSendMode = 'relevant';
  out.contactRelevant = await ppCountTokens(ppBuildContactBlock() || '');
  cfg.contactSendMode = 'all';
  out.contactAll = await ppCountTokens(ppBuildContactBlock() || '');
 } catch (e) {
  console.warn('[pocket-phone] measure tokens', e);
  out.ok = false;
  out.tokenizer = 'วัดไม่สำเร็จ — ' + (e && e.message ? e.message : 'ไม่ทราบสาเหตุ');
 } finally {
  cfg.bridgeMods = saved;
  cfg.contactSendMode = savedMode;
 }
 out.total = ppBridgeActiveTotal(out);
 cfg.bridgeTokenCache = out;
 saveCfg();
 return out;
}
const PP_DRAMA_PROMPT_SAMPLE = `ALSO: this account has 1000 followers, so random strangers see this post too. Add 1-3 stranger comments — invent short Thai internet nicknames yourself. Format each on its own line EXACTLY: [GHOST]nickname|N "comment text". Strangers can be nosy, supportive, or start petty drama. Keep them SHORT.
FINALLY, on the very last line, judge how Thai social media receives this post, format EXACTLY: [CLOUT] good|0-3|short reason  (use good / mid / bad ; second number = drama heat 0=none 3=full flame war). Thai netizens are quick to find something to argue about, so do not default to "good".`;
function ppBridgeActiveTotal(cache) {
 const c = cache || getCfg().bridgeTokenCache;
 if (!c || !c.mods) return 0;
 let sum = c.mods.core || 0;
 BRIDGE_MOD_META.forEach(m => { if (bridgeOn(m.key)) sum += (c.mods[m.key] || 0); });
 return sum;
}
function ppApplyBridgePreset(kind) {
 const cfg = getCfg();
 const all = Object.keys(DEFAULTS.bridgeMods);
 if (kind === 'off') all.forEach(k => { cfg.bridgeMods[k] = false; });
 else if (kind === 'all') all.forEach(k => { cfg.bridgeMods[k] = true; });
 else {
  all.forEach(k => { cfg.bridgeMods[k] = false; });
  ['msg', 'groupcall', 'wallet', 'inv_contacts', 'actionlog'].forEach(k => { cfg.bridgeMods[k] = true; });
 }
 saveCfg();
}
// ── ผลซิงค์รายอัน ──
function ppPushSyncEvent(ok, type, label, reason) {
 const cfg = getCfg();
 if (!Array.isArray(cfg.syncEventLog)) cfg.syncEventLog = [];
 cfg.syncEventLog.push({ ts: Date.now(), ok: !!ok, type: String(type || '?').slice(0, 40), label: String(label || '').slice(0, 120), reason: String(reason || '').slice(0, 140) });
 if (cfg.syncEventLog.length > 120) cfg.syncEventLog = cfg.syncEventLog.slice(-120);
 saveCfg();
}
window.PP_LOADED = 'parsed-1of4';
console.log(`[pocket-phone] ${PP_VERSION} ท่อน 1/4 พร้อม - Action Log core โหลดแล้ว`);

// pocket-phone/index.js — 0.9.9 — ท่อน 2/4 (ICON → iGlassOS CSS → buildPhone)
// ต่อจากท่อน 1/4 ที่จบตรง window.PP_LOADED = 'parsed-1of4'
// ★ SVG ล้วน ไม่มีอิโมจิแม้ตัวเดียว · ไม่มี inline style (ย้ายไป CSS หมด)
// ⚠️ รันเดี่ยวไม่ได้ ต้องแปะครบ 4 ท่อน

// ══════════════════════════════════════════════════════════
// ICON — SVG ล้วน ทุกตัว currentColor
// ══════════════════════════════════════════════════════════
const ICON = {
 // status bar
 signal: `<svg viewBox="0 0 18 12" fill="currentColor"><rect y="8" width="3" height="4" rx=".7"/><rect x="5" y="5.5" width="3" height="6.5" rx=".7"/><rect x="10" y="3" width="3" height="9" rx=".7"/><rect x="15" width="3" height="12" rx=".7"/></svg>`,
 wifi: `<svg viewBox="0 0 24 18" fill="currentColor"><path d="M12 3C8 3 4.4 4.6 1.8 7.2l1.8 1.8C5.8 6.8 8.7 5.5 12 5.5s6.2 1.3 8.4 3.5l1.8-1.8C19.6 4.6 16 3 12 3zm0 6c-2 0-3.8.8-5.1 2.1l1.8 1.8C9.5 12.1 10.7 11.5 12 11.5s2.5.6 3.3 1.4l1.8-1.8A7.2 7.2 0 0 0 12 9zm0 5.5-2.1 2.1c.6.6 1.4.9 2.1.9s1.5-.3 2.1-.9L12 14.5z"/></svg>`,
 battery: `<svg viewBox="0 0 26 12" fill="none"><rect x=".5" y=".5" width="21" height="11" rx="3" stroke="currentColor" stroke-opacity=".4"/><rect x="2" y="2" width="16" height="8" rx="1.5" fill="currentColor"/><rect x="23" y="4" width="1.8" height="4" rx=".9" fill="currentColor" fill-opacity=".4"/></svg>`,

 // nav
 back: `<svg viewBox="0 0 12 20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 2 2 10l8 8"/></svg>`,
 fwd: `<svg viewBox="0 0 12 20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 2l8 8-8 8"/></svg>`,
 close: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M18.3 5.7 12 12l6.3 6.3-1.4 1.4L10.6 13.4 4.3 19.7 2.9 18.3 9.2 12 2.9 5.7 4.3 4.3 10.6 10.6 16.9 4.3z"/></svg>`,
 menu: `<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>`,
 chevron: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9 6l6 6-6 6"/></svg>`,
 check: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z"/></svg>`,
 plus: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M11 5v6H5v2h6v6h2v-6h6v-2h-6V5z"/></svg>`,
 minus: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M5 11h14v2H5z"/></svg>`,
 search: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M15.5 14h-.8l-.3-.3a6.5 6.5 0 1 0-.7.7l.3.3v.8l5 5 1.5-1.5-5-5zm-6 0A4.5 4.5 0 1 1 14 9.5 4.5 4.5 0 0 1 9.5 14z"/></svg>`,
 gear: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M19.14 12.94c.04-.3.06-.61.06-.94s-.02-.64-.07-.94l2.03-1.58a.5.5 0 0 0 .12-.61l-1.92-3.32a.5.5 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54A.49.49 0 0 0 13.5 2h-3c-.24 0-.44.17-.47.41l-.36 2.54c-.59.24-1.13.56-1.62.94l-2.39-.96a.5.5 0 0 0-.59.22L2.74 8.87a.5.5 0 0 0 .12.61l2.03 1.58c-.05.3-.07.63-.07.94s.02.64.07.94L2.86 14.52a.5.5 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.03.24.23.41.47.41h3c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32a.5.5 0 0 0-.12-.61l-2.03-1.58zM12 15.5A3.5 3.5 0 1 1 12 8.5a3.5 3.5 0 0 1 0 7z"/></svg>`,

 // apps
 messages: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 3C6.9 3 3 6.6 3 11c0 2.3 1.1 4.4 2.9 5.8-.2 1.3-.8 2.5-1.6 3.4-.2.2 0 .6.3.5 1.9-.3 3.4-1 4.4-1.6 1 .3 2 .4 3 .4 5.1 0 9-3.6 9-8s-3.9-8-9-8z"/></svg>`,
 feed: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4.2"/><circle cx="17.4" cy="6.6" r="1.2" fill="currentColor" stroke="none"/></svg>`,
 wallet: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="2.5" y="6" width="19" height="12.5" rx="3"/><path d="M2.5 10.2h19" stroke-width="1.9"/><circle cx="17.5" cy="14.6" r="1.2" fill="currentColor" stroke="none"/></svg>`,
 calendar: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 2v2H5.5A2.5 2.5 0 0 0 3 6.5v13A2.5 2.5 0 0 0 5.5 22h13a2.5 2.5 0 0 0 2.5-2.5v-13A2.5 2.5 0 0 0 18.5 4H17V2h-2v2H9V2H7zm12 8v9.5H5V10h14z"/></svg>`,
 phoneApp: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z"/></svg>`,
 users: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M16 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm-8 0a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm0 2c-2.7 0-8 1.3-8 4v3h9v-3c0-1 .4-1.9 1-2.6-.7-.3-1.4-.4-2-.4zm8 0c-.6 0-1.3.1-2 .2 1 .8 2 1.9 2 3.8v3h8v-3c0-2.7-5.3-4-8-4z"/></svg>`,

 // chat
 compose: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>`,
 send: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3.4 20.4 20.9 12 3.4 3.6 3.4 10l12 2-12 2z"/></svg>`,
 generate: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2.5l1.6 4.3 4.3 1.6-4.3 1.6L12 14.3l-1.6-4.3L6.1 8.4l4.3-1.6L12 2.5z"/><path d="M18.4 13.6l.9 2.3 2.3.9-2.3.9-.9 2.3-.9-2.3-2.3-.9 2.3-.9.9-2.3z"/></svg>`,
 stop: `<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2.5"/></svg>`,
 regen: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M17.65 6.35A8 8 0 1 0 19.73 13h-2.08A6 6 0 1 1 12 6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg>`,
 star: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 3.4l2.6 5.4 5.9.8-4.3 4.1 1.1 5.9L12 16.8l-5.3 2.8 1.1-5.9L3.5 9.6l5.9-.8L12 3.4z"/></svg>`,
 starOut: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M12 4.2l2.4 4.9 5.4.8-3.9 3.8 1 5.4L12 16.5l-4.9 2.6 1-5.4-3.9-3.8 5.4-.8L12 4.2z"/></svg>`,
 reply: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M10 9V5l-7 7 7 7v-4c5 0 8 1.5 10 5-.5-6-3.5-11-10-11z"/></svg>`,
 share: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M18 16a3 3 0 0 0-2.4 1.2l-7-4a3 3 0 0 0 0-2.4l7-4A3 3 0 1 0 15 5l-7 4a3 3 0 1 0 0 6l7 4A3 3 0 1 0 18 16z"/></svg>`,
 trash: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 7h12l-1 13H7L6 7zm3-3h6l1 2H8l1-2z"/></svg>`,
 pin: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M16 4v6l2 3v2h-5v6l-1 1-1-1v-6H6v-2l2-3V4h8z"/></svg>`,
 bell: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 22a2.5 2.5 0 0 0 2.45-2h-4.9A2.5 2.5 0 0 0 12 22zm7-6v-5a7 7 0 0 0-5-6.7V4a2 2 0 0 0-4 0v.3A7 7 0 0 0 5 11v5l-2 2v1h18v-1l-2-2z"/></svg>`,
 bellOff: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 22a2.5 2.5 0 0 0 2.45-2h-4.9A2.5 2.5 0 0 0 12 22zM19 16v-5a7 7 0 0 0-5-6.7V4a2 2 0 0 0-4 0v.3A7 7 0 0 0 5 11v5l-2 2v1h18v-1l-2-2z"/><path d="M3 3l18 18" stroke="currentColor" stroke-width="2.2" fill="none"/></svg>`,
 archive: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 4h18v4H3V4zm1 6h16v9a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-9zm5 2v2h6v-2H9z"/></svg>`,
 camera: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M9 4l-1.7 2H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-3.3L15 4H9zm3 5a4.5 4.5 0 1 1 0 9 4.5 4.5 0 0 1 0-9z"/></svg>`,
 image: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zm0 13.5h16v-2.2l-4.3-4.3-3.5 3.5-2.5-2.5L4 15.3v2.2zM8.5 9.5a1.8 1.8 0 1 0 0-3.6 1.8 1.8 0 0 0 0 3.6z"/></svg>`,
 mic: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2z"/></svg>`,
 speaker: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02z"/></svg>`,
 play: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>`,
 pause: `<svg viewBox="0 0 24 24" fill="currentColor"><rect x="7" y="5" width="3.6" height="14" rx="1.2"/><rect x="13.4" y="5" width="3.6" height="14" rx="1.2"/></svg>`,
 sticker: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M4 8a4 4 0 0 1 4-4h6l6 6v6a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4V8z"/><path d="M14 4v4a2 2 0 0 0 2 2h4"/></svg>`,
 pin2: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2a7 7 0 0 0-7 7c0 5 7 13 7 13s7-8 7-13a7 7 0 0 0-7-7zm0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5z"/></svg>`,
 card: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="3" y="5" width="18" height="14" rx="3"/><circle cx="9" cy="11" r="2.2"/><path d="M5.5 16.5c.8-1.6 2-2.3 3.5-2.3s2.7.7 3.5 2.3M15 9.5h4M15 13h3"/></svg>`,
 gift: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M20 7h-2.2a3 3 0 0 0-4.3-4L12 4.3 10.5 3a3 3 0 0 0-4.3 4H4a1 1 0 0 0-1 1v3h8V8h2v3h8V8a1 1 0 0 0-1-1zM4 13v7a1 1 0 0 0 1 1h6v-8H4zm9 8h6a1 1 0 0 0 1-1v-7h-7v8z"/></svg>`,
 poll: `<svg viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="12" width="3.4" height="8" rx="1.2"/><rect x="10.3" y="7" width="3.4" height="13" rx="1.2"/><rect x="16.6" y="4" width="3.4" height="16" rx="1.2"/></svg>`,
 transfer: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 6h11l-2.5-2.5L17 2l5 5-5 5-1.5-1.5L18 8H7V6zm10 12H6l2.5 2.5L7 22l-5-5 5-5 1.5 1.5L6 16h11v2z"/></svg>`,
 money: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 1a11 11 0 1 0 0 22 11 11 0 0 0 0-22zm.9 16.2v1.3h-1.7v-1.3c-1.6-.2-2.8-1-3-2.6h1.9c.1.7.7 1.2 1.9 1.2 1.1 0 1.7-.5 1.7-1.2 0-.6-.4-1-1.9-1.4-2-.5-3.3-1.1-3.3-2.9 0-1.4 1.1-2.3 2.7-2.6V6.4h1.7v1.3c1.6.3 2.5 1.3 2.6 2.6h-1.9c-.1-.7-.5-1.2-1.6-1.2s-1.6.5-1.6 1.1c0 .6.5.9 1.9 1.3 2 .5 3.3 1.2 3.3 3 0 1.4-1 2.4-2.9 2.7z"/></svg>`,
 arrowIn: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 3v12.2l4.6-4.6L18 12l-6 6-6-6 1.4-1.4L12 15.2V3z"/></svg>`,
 arrowOut: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 21V8.8L7.4 13.4 6 12l6-6 6 6-1.4 1.4L12 8.8V21z"/></svg>`,
 hangup: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z" transform="rotate(135 12 12)"/></svg>`,
 heart: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 21s-7.5-4.6-10-9.2C.5 8.4 2 5 5.3 5c2 0 3.4 1.3 4.2 2.5C10.3 6.3 11.7 5 13.7 5 17 5 18.5 8.4 22 11.8 19.5 16.4 12 21 12 21z"/></svg>`,
 heartOut: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 20.2s-6.9-4.3-9.2-8.5C1.4 8.7 2.6 6 5.4 6c1.8 0 3 1.1 3.8 2.2C10 7.1 11.2 6 13 6c2.8 0 4 2.7 2.6 5.7-2.3 4.2-3.6 8.5-3.6 8.5z"/></svg>`,
 comment: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M21 12a8 8 0 0 1-11.5 7.2L3 21l1.8-6.5A8 8 0 1 1 21 12z"/></svg>`,
 bookmark: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 3h12a1 1 0 0 1 1 1v17l-7-4-7 4V4a1 1 0 0 1 1-1z"/></svg>`,
 bookmarkOut: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M6.5 3.8h11a.7.7 0 0 1 .7.7v15.2l-6.2-3.6-6.2 3.6V4.5a.7.7 0 0 1 .7-.7z"/></svg>`,
 grid: `<svg viewBox="0 0 24 24" fill="currentColor"><rect x="3" y="3" width="5.6" height="5.6" rx="1.3"/><rect x="9.2" y="3" width="5.6" height="5.6" rx="1.3"/><rect x="15.4" y="3" width="5.6" height="5.6" rx="1.3"/><rect x="3" y="9.2" width="5.6" height="5.6" rx="1.3"/><rect x="9.2" y="9.2" width="5.6" height="5.6" rx="1.3"/><rect x="15.4" y="9.2" width="5.6" height="5.6" rx="1.3"/><rect x="3" y="15.4" width="5.6" height="5.6" rx="1.3"/><rect x="9.2" y="15.4" width="5.6" height="5.6" rx="1.3"/><rect x="15.4" y="15.4" width="5.6" height="5.6" rx="1.3"/></svg>`,
 compass: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="12" cy="12" r="9"/><path d="M15.5 8.5l-2 5-5 2 2-5 5-2z" fill="currentColor" stroke="none"/></svg>`,
 person: `<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-6 8-6s8 2 8 6v1H4v-1z"/></svg>`,
 lock: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2a5 5 0 0 0-5 5v3H6a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V11a1 1 0 0 0-1-1h-1V7a5 5 0 0 0-5-5zm-3 8V7a3 3 0 0 1 6 0v3H9z"/></svg>`,
 unlock: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2a5 5 0 0 0-5 5h2a3 3 0 0 1 6 0v3H6a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V11a1 1 0 0 0-1-1h-1V7a5 5 0 0 0-5-5z"/></svg>`,
 eye: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 5C6.5 5 2.7 9.2 1.5 12c1.2 2.8 5 7 10.5 7s9.3-4.2 10.5-7c-1.2-2.8-5-7-10.5-7zm0 11a4 4 0 1 1 0-8 4 4 0 0 1 0 8z"/></svg>`,
 drop: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2.5S5.5 10 5.5 14.5A6.5 6.5 0 0 0 18.5 14.5C18.5 10 12 2.5 12 2.5z"/></svg>`,
 chart: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 18l4.5-5 3.5 3 7.5-8"/></svg>`,
 clock: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path d="M12 7.5V12l3.2 2"/></svg>`,
 upload: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M5 20h14v-2H5v2zM12 4l-5 5h3v6h4V9h3l-5-5z"/></svg>`,
 goto: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M14 4l-1.4 1.4L16.2 9H4v2h12.2l-3.6 3.6L14 16l6-6z"/></svg>`,
 ban: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/></svg>`,
 link: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M10.6 13.4a1 1 0 0 1 0-1.4l1.4-1.4a1 1 0 0 1 1.4 1.4l-1.4 1.4a1 1 0 0 1-1.4 0zM8 16a4 4 0 0 1 0-5.7l2.1-2.1 1.4 1.4L9.4 11.7a2 2 0 0 0 2.9 2.9l2.1-2.1 1.4 1.4-2.1 2.1A4 4 0 0 1 8 16zm8-8a4 4 0 0 1 0 5.7l-2.1 2.1-1.4-1.4 2.1-2.1a2 2 0 0 0-2.9-2.9L9.6 11.5 8.2 10.1l2.1-2.1A4 4 0 0 1 16 8z"/></svg>`,
 repost: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M17 2.5l3.5 3.5L17 9.5"/><path d="M20.5 6H8.5A3.5 3.5 0 0 0 5 9.5V12"/><path d="M7 21.5L3.5 18 7 14.5"/><path d="M3.5 18h12A3.5 3.5 0 0 0 19 14.5V12"/></svg>`,
 news: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="2.5" y="4.5" width="15" height="15" rx="2.5"/><path d="M17.5 8.5h2A2 2 0 0 1 21.5 10.5v6.5a2.5 2.5 0 0 1-2.5 2.5"/><path d="M5.5 8h9M5.5 11.5h9M5.5 15h5.5" stroke-linecap="round"/></svg>`,
 at: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="4"/><path d="M16 8v5a2.5 2.5 0 0 0 5 0v-1a9 9 0 1 0-3.4 7.05" stroke-linecap="round"/></svg>`,
 trend: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3 17l5.5-5.5 3.5 3.5L21 6"/><path d="M15 6h6v6"/></svg>`,
 fire: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M13.5 2s.8 3-1.5 5.2C9.4 9.7 7 11.4 7 14.8A6.2 6.2 0 0 0 13.2 21c3.6 0 6.3-2.6 6.3-6.1 0-2.5-1.2-4.2-2.6-5.6.2 1.5-.4 2.6-1.3 3.1.5-2.6-.4-6.9-2.1-10.4z"/></svg>`,
};

const APPS = [
 { nav: 'messages', label: 'ข้อความ', glow: '#5ce07f', icon: ICON.messages },
 { nav: 'feed', label: 'ฟีด', glow: '#ff6482', icon: ICON.feed },
 { nav: 'period', label: 'ประจำเดือน', glow: '#ff5e8a', icon: ICON.drop },
 { nav: 'wallet', label: 'กระเป๋าเงิน', glow: '#ffc061', icon: ICON.wallet },
 { nav: 'calllog', label: 'โทรศัพท์', glow: '#64d2ff', icon: ICON.phoneApp },
 { nav: 'helper', label: 'ผู้ช่วย', glow: '#a4f0b8', icon: ICON.eye },
 { nav: 'settings', label: 'ตั้งค่า', glow: '#d0d0d5', icon: ICON.gear },
];

// ══════════════════════════════════════════════════════════
// iGlassOS — design system
// ══════════════════════════════════════════════════════════
function injectCSS() {
 if (document.getElementById('pp-css')) return;
 const s = document.createElement('style');
 s.id = 'pp-css';
 s.textContent = `
.pp-hk{display:none !important;}
:root{
 --pp-spring: cubic-bezier(.32,1.35,.36,1);
 --pp-ease: cubic-bezier(.4,0,.2,1);
}

/* ══ FAB ══ */
#pp-fab{position:fixed;width:44px;height:44px;border:none;border-radius:50%;cursor:grab;z-index:2147483000;
 display:flex;align-items:center;justify-content:center;color:#fff;padding:0;opacity:.8;
 background:rgba(28,28,32,.7);
 backdrop-filter:blur(16px) saturate(1.4);-webkit-backdrop-filter:blur(16px) saturate(1.4);
 border:.5px solid rgba(255,255,255,.15);
 box-shadow:0 4px 14px rgba(0,0,0,.3);
 transition:opacity .2s,transform .2s var(--pp-spring);touch-action:none;}
#pp-fab:hover{opacity:1;}
#pp-fab:active{cursor:grabbing;transform:scale(.9);}
#pp-fab.pp-dragging{transform:scale(1.12);box-shadow:0 16px 40px rgba(0,0,0,.55);transition:none;}
#pp-fab svg{width:20px;height:20px;opacity:.9;}
#pp-fab .pp-logbadge{position:absolute;top:-3px;right:-3px;min-width:19px;height:19px;border-radius:10px;
 background:#ff453a;color:#fff;font-size:11px;font-weight:700;line-height:19px;text-align:center;padding:0 5px;
 border:2px solid rgba(20,20,24,.9);display:none;}
#pp-fab .pp-logbadge.on{display:block;}

/* ══ dialog / frame ══ */
#pp-dialog{display:none;padding:0;border:none;background:transparent;width:100vw;height:100dvh;
 max-width:100vw;max-height:100dvh;align-items:center;justify-content:center;overflow:hidden;}
#pp-dialog[open]{display:flex;}
#pp-dialog::backdrop{background:rgba(0,0,0,.92);}

#pp-frame{
 --pp-accent:#0a84ff;
 --pp-txt:#fff;--pp-txt2:rgba(235,235,245,.78);--pp-txt3:rgba(235,235,245,.55);
 --pp-fill1:rgba(120,120,128,.32);--pp-fill2:rgba(120,120,128,.22);--pp-fill3:rgba(120,120,128,.14);
 --pp-sep:rgba(255,255,255,.1);--pp-sep2:rgba(255,255,255,.055);
 --pp-glass:rgba(28,28,30,.62);--pp-glass2:rgba(44,44,48,.78);--pp-sheet:rgba(38,38,42,.94);
 --pp-bub-in:rgba(120,120,128,.3);--pp-card:rgba(255,255,255,.055);
 --pp-surface:#0d0d11;
 width:min(393px,100vw);height:min(852px,100dvh);border-radius:46px;overflow:hidden;position:relative;
 display:flex;flex-direction:column;color:var(--pp-txt);
 background:radial-gradient(120% 80% at 50% 0%,#16161a,#050506 72%);
 font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",Roboto,sans-serif;
 -webkit-font-smoothing:antialiased;
 box-shadow:0 0 0 11px #18181c,0 0 0 13px #0e0e11,0 40px 100px rgba(0,0,0,.9);}
#pp-frame.light{
 --pp-txt:#000;--pp-txt2:rgba(60,60,67,.78);--pp-txt3:rgba(60,60,67,.5);
 --pp-fill1:rgba(120,120,128,.2);--pp-fill2:rgba(120,120,128,.13);--pp-fill3:rgba(120,120,128,.08);
 --pp-sep:rgba(0,0,0,.09);--pp-sep2:rgba(0,0,0,.05);
 --pp-glass:rgba(249,249,251,.72);--pp-glass2:rgba(255,255,255,.86);--pp-sheet:rgba(250,250,252,.96);
 --pp-bub-in:rgba(120,120,128,.2);--pp-card:rgba(0,0,0,.035);
 --pp-surface:#ffffff;
 background:radial-gradient(120% 80% at 50% 0%,#fff,#e8e8ee 72%);}

/* ══ status bar + island ══ */
#pp-statusbar{height:52px;flex-shrink:0;position:relative;display:flex;align-items:center;
 justify-content:space-between;padding:8px 24px 0;font-size:15px;font-weight:700;z-index:70;}
.pp-sb-left{min-width:62px;transition:opacity .3s;}
.pp-sb-right{display:flex;align-items:center;gap:6px;transition:opacity .3s;}
.pp-sb-right svg{height:12px;width:auto;}
#pp-close-btn{background:var(--pp-fill1);border:none;border-radius:50%;width:22px;height:22px;color:inherit;
 cursor:pointer;margin-left:6px;display:flex;align-items:center;justify-content:center;padding:0;}
#pp-close-btn svg{width:11px;height:11px;}
#pp-frame:has(#pp-island.pp-island-live) .pp-sb-left,
#pp-frame:has(#pp-island.pp-island-live) .pp-sb-right{opacity:.18;}

#pp-island{position:absolute;top:11px;left:50%;transform:translateX(-50%);width:118px;height:33px;
 border-radius:20px;background:#000;z-index:60;overflow:hidden;display:flex;align-items:center;justify-content:center;
 box-shadow:inset 0 0 0 .5px rgba(255,255,255,.1),0 2px 8px rgba(0,0,0,.5);
 transition:width .55s var(--pp-spring),height .55s var(--pp-spring),border-radius .5s var(--pp-ease);}
#pp-island.pp-island-live{width:min(302px,84%);height:62px;border-radius:31px;justify-content:flex-start;
 padding:0 16px;gap:12px;cursor:pointer;box-shadow:inset 0 0 0 .5px rgba(255,255,255,.14),0 14px 44px rgba(0,0,0,.7);}
#pp-ext-island{position:fixed;top:12px;left:50%;transform:translateX(-50%);width:118px;height:33px;
 border-radius:20px;background:#000;z-index:2147482000;overflow:hidden;display:none;
 align-items:center;justify-content:center;cursor:pointer;
 font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text",sans-serif;
 box-shadow:inset 0 0 0 .5px rgba(255,255,255,.12),0 8px 24px rgba(0,0,0,.55);
 transition:width .55s var(--pp-spring),height .55s var(--pp-spring),border-radius .5s var(--pp-ease);}
.pp-island-av{width:40px;height:40px;border-radius:50%;object-fit:cover;flex-shrink:0;background:#333;
 opacity:0;transform:scale(.4);transition:opacity .3s .16s,transform .42s .16s var(--pp-spring);}
.pp-island-av-fb{display:flex;align-items:center;justify-content:center;color:#fff;font-weight:600;font-size:16px;
 text-transform:uppercase;background:linear-gradient(160deg,#8e8e93,#545458);}
.pp-island-body{flex:1;min-width:0;opacity:0;transform:translateX(-6px);transition:opacity .3s .2s,transform .32s .2s;}
.pp-island-live .pp-island-av,.pp-island-live .pp-island-body{opacity:1;transform:none;}
.pp-island-name{font-size:13px;font-weight:700;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.pp-island-msg{font-size:13px;color:rgba(235,235,245,.8);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px;}
.pp-island-typing{display:flex;gap:4px;margin-top:5px;}
.pp-island-typing span{width:6px;height:6px;border-radius:50%;background:rgba(235,235,245,.8);animation:pp-bounce .9s infinite ease-in-out;}
.pp-island-typing span:nth-child(2){animation-delay:.15s;}
.pp-island-typing span:nth-child(3){animation-delay:.3s;}

/* ══ screens ══ */
#pp-screens{flex:1;position:relative;overflow:hidden;}
.pp-screen{position:absolute;inset:0;display:none;flex-direction:column;}
.pp-screen.show{display:flex;}
.pp-screen.pp-enter{animation:pp-slide-in .34s var(--pp-ease);}
@keyframes pp-slide-in{from{transform:translateX(28px);opacity:.4}to{transform:none;opacity:1}}

/* ══ home ══ */
#pp-home{align-items:stretch;padding:6px 0 0;overflow:hidden;}
#pp-home-wp{position:absolute;inset:-12%;z-index:0;pointer-events:none;background-size:cover;background-position:center;}
#pp-home>*:not(#pp-home-wp){position:relative;z-index:1;}
.pp-home-clock{font-size:74px;font-weight:200;text-align:center;letter-spacing:-4px;line-height:1;
 text-shadow:0 2px 32px rgba(0,0,0,.4);margin-top:6px;}
#pp-home-date{font-size:17px;font-weight:500;opacity:.9;text-align:center;margin-top:2px;text-shadow:0 1px 8px rgba(0,0,0,.45);}
.pp-home-widgets{display:flex;gap:10px;padding:16px 22px 0;}
.pp-widget{flex:1;border-radius:22px;padding:13px 15px;background:var(--pp-card);
 backdrop-filter:blur(22px) saturate(1.7);-webkit-backdrop-filter:blur(22px) saturate(1.7);
 border:.5px solid rgba(255,255,255,.16);
 box-shadow:inset 0 1px 0 rgba(255,255,255,.2),0 8px 24px rgba(0,0,0,.3);cursor:pointer;
 transition:transform .18s var(--pp-spring);}
.pp-widget:active{transform:scale(.96);}
.pp-widget-head{display:flex;align-items:center;gap:6px;font-size:11px;font-weight:700;color:var(--pp-txt3);
 text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px;}
.pp-widget-head svg{width:12px;height:12px;}
.pp-widget-main{font-size:21px;font-weight:700;letter-spacing:-.4px;}
.pp-widget-sub{font-size:12px;color:var(--pp-txt3);margin-top:2px;}
.pp-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:22px 14px;padding:20px 24px 8px;}
.pp-app{background:none;border:none;cursor:pointer;display:flex;flex-direction:column;align-items:center;gap:7px;
 color:inherit;padding:0;transition:transform .16s var(--pp-spring);}
.pp-app:active{transform:scale(.88);}
.pp-icon{position:relative;width:58px;height:58px;border-radius:30%;display:flex;align-items:center;justify-content:center;
 overflow:hidden;background:linear-gradient(180deg,rgba(255,255,255,.2),rgba(255,255,255,.045));
 backdrop-filter:blur(22px) saturate(1.9);-webkit-backdrop-filter:blur(22px) saturate(1.9);
 border:.5px solid rgba(255,255,255,.2);
 box-shadow:inset 0 1.4px 0 rgba(255,255,255,.52),inset 0 -10px 18px rgba(0,0,0,.14),0 10px 26px rgba(0,0,0,.42);}
.pp-icon::after{content:'';position:absolute;inset:0;border-radius:inherit;pointer-events:none;
 background:linear-gradient(180deg,rgba(255,255,255,.3),transparent 46%);}
.pp-icon svg{width:29px;height:29px;position:relative;z-index:1;filter:drop-shadow(0 1px 4px rgba(0,0,0,.35));}
.pp-label{font-size:12px;font-weight:500;opacity:.95;text-shadow:0 1px 6px rgba(0,0,0,.6);}
.pp-icon-badge{position:absolute;top:-2px;right:-2px;min-width:20px;height:20px;border-radius:11px;background:#ff453a;
 color:#fff;font-size:11px;font-weight:700;line-height:20px;text-align:center;padding:0 5px;z-index:3;
 border:2px solid rgba(10,10,14,.86);display:none;}
.pp-icon-badge:empty{display:none !important;}
.pp-home-bar{width:132px;height:5px;border-radius:3px;background:rgba(220,220,225,.55);margin:auto auto 9px;}

/* ══ nav bar ══ */
.pp-nav{min-height:46px;flex-shrink:0;display:flex;align-items:center;padding:0 8px;position:relative;
 background:var(--pp-glass);backdrop-filter:blur(30px) saturate(1.8);-webkit-backdrop-filter:blur(30px) saturate(1.8);
 border-bottom:.5px solid var(--pp-sep);z-index:20;}
.pp-nav-back,.pp-nav-action{background:none;border:none;color:var(--pp-accent);cursor:pointer;
 min-width:34px;height:34px;display:flex;align-items:center;justify-content:center;padding:0 5px;
 border-radius:10px;transition:background .15s;}
.pp-nav-action:active,.pp-nav-back:active{background:var(--pp-fill3);}
.pp-nav-back svg{width:11px;height:18px;}
.pp-nav-action svg{width:19px;height:19px;}
.pp-nav-title{position:absolute;left:50%;transform:translateX(-50%);font-size:17px;font-weight:700;
 color:var(--pp-txt);white-space:nowrap;max-width:52%;overflow:hidden;text-overflow:ellipsis;}
.pp-nav-tools{display:flex;align-items:center;gap:2px;margin-left:auto;}
.pp-nav-txtbtn{font-size:15px;font-weight:600;padding:0 8px;}
.pp-largetitle{padding:6px 20px 10px;font-size:32px;font-weight:800;letter-spacing:-.8px;color:var(--pp-txt);}

/* ══ segmented + tabs ══ */
.pp-seg{display:flex;background:var(--pp-fill3);border-radius:11px;padding:2px;margin:10px 16px;}
.pp-seg button{flex:1;background:none;border:none;color:var(--pp-txt2);font-size:13px;font-weight:600;
 padding:7px 0;border-radius:9px;cursor:pointer;transition:all .22s var(--pp-ease);}
.pp-seg button.on{background:var(--pp-glass2);color:var(--pp-txt);
 box-shadow:0 1px 4px rgba(0,0,0,.2),inset 0 .5px 0 rgba(255,255,255,.2);}
.pp-tabs{display:flex;flex-shrink:0;border-bottom:.5px solid var(--pp-sep);padding:0 8px;}
.pp-tabs button{flex:1;background:none;border:none;color:var(--pp-txt3);font-size:14px;font-weight:600;
 padding:11px 0 9px;cursor:pointer;border-bottom:2px solid transparent;transition:color .18s;}
.pp-tabs button.on{color:var(--pp-txt);border-bottom-color:var(--pp-accent);}
.pp-tabbar{flex-shrink:0;display:flex;background:var(--pp-glass);border-top:.5px solid var(--pp-sep);
 backdrop-filter:blur(30px) saturate(1.8);-webkit-backdrop-filter:blur(30px) saturate(1.8);padding:5px 0 3px;}
.pp-tabbar button{flex:1;background:none;border:none;color:var(--pp-txt3);cursor:pointer;padding:4px 0;
 display:flex;flex-direction:column;align-items:center;gap:2px;position:relative;transition:color .18s;}
.pp-tabbar button.on{color:var(--pp-accent);}
.pp-tabbar svg{width:23px;height:23px;}
.pp-tabbar span{font-size:10px;font-weight:600;}
.pp-tabbar .pp-tb-badge{position:absolute;top:0;right:calc(50% - 18px);min-width:16px;height:16px;border-radius:9px;
 background:#ff453a;color:#fff;font-size:10px;font-weight:700;line-height:16px;padding:0 4px;}

/* ══ list / rows ══ */
.pp-list{flex:1;overflow-y:auto;overscroll-behavior:contain;-webkit-overflow-scrolling:touch;}
.pp-list-head{padding:14px 18px 5px;font-size:12px;font-weight:700;color:var(--pp-txt3);
 text-transform:uppercase;letter-spacing:.6px;}
.pp-scope-bar{margin:8px 16px 4px;padding:8px 12px;border-radius:12px;background:var(--pp-fill3);
 color:var(--pp-txt2);font-size:12px;cursor:pointer;text-align:center;border:.5px solid var(--pp-sep2);}
.pp-scope-bar:active{background:var(--pp-fill2);}
.pp-row{display:flex;align-items:center;gap:13px;padding:9px 16px;cursor:pointer;position:relative;
 transition:background .14s;}
.pp-row:active{background:var(--pp-fill3);}
.pp-row-meta{flex:1;min-width:0;}
.pp-row-name{font-size:16px;font-weight:600;color:var(--pp-txt);display:flex;align-items:center;gap:5px;}
.pp-row-name svg{width:13px;height:13px;color:var(--pp-txt3);flex-shrink:0;}
.pp-row-sub{font-size:14px;color:var(--pp-txt3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:1px;}
.pp-row-right{display:flex;flex-direction:column;align-items:flex-end;gap:4px;flex-shrink:0;}
.pp-row-time{font-size:12px;color:var(--pp-txt3);}
.pp-badge{min-width:20px;height:20px;border-radius:11px;background:var(--pp-accent);color:#fff;font-size:11px;
 font-weight:700;line-height:20px;text-align:center;padding:0 6px;}
.pp-row.muted .pp-row-name,.pp-row.muted .pp-row-sub{opacity:.5;}
.pp-typing-txt{color:var(--pp-accent);font-style:italic;}
.pp-empty{text-align:center;padding:56px 26px;color:var(--pp-txt3);font-size:16px;line-height:1.7;}
.pp-empty span{font-size:13px;opacity:.8;display:block;margin-top:4px;}
.pp-empty svg{width:44px;height:44px;opacity:.3;margin-bottom:12px;}

/* swipe actions */
.pp-swipe{position:relative;overflow:hidden;}
.pp-swipe-inner{position:relative;background:var(--pp-surface);transition:transform .24s var(--pp-ease);will-change:transform;}
.pp-swipe.dragging .pp-swipe-inner{transition:none;}
.pp-swipe-acts{position:absolute;top:0;right:0;bottom:0;display:flex;opacity:0;pointer-events:none;transition:opacity .12s;}
.pp-swipe.dragging .pp-swipe-acts,.pp-swipe.open .pp-swipe-acts{opacity:1;pointer-events:auto;}
.pp-swipe-acts button{border:none;color:#fff;width:72px;display:flex;flex-direction:column;align-items:center;
 justify-content:center;gap:3px;font-size:11px;font-weight:600;cursor:pointer;padding:0;}
.pp-swipe-acts svg{width:17px;height:17px;}
.pp-sw-pin{background:#ff9f0a;}
.pp-sw-mute{background:#5e5ce6;}
.pp-sw-arch{background:#636366;}
.pp-sw-del{background:#ff453a;}

/* avatar */
.pp-avatar{border-radius:50%;object-fit:cover;flex-shrink:0;background:var(--pp-fill2);display:block;}
.pp-avatar-fb{display:flex;align-items:center;justify-content:center;font-weight:600;color:#fff;
 text-transform:uppercase;background:linear-gradient(160deg,#8e8e93,#545458);}
.pp-grp-av{position:relative;display:inline-block;flex-shrink:0;}
.pp-grp-av-piece{position:absolute;border-radius:50%;overflow:hidden;box-shadow:0 0 0 2px rgba(20,20,24,.9);}
.pp-grp-av-piece.pos0{top:0;left:0;}
.pp-grp-av-piece.pos1{bottom:0;right:0;}

/* search */
.pp-search-wrap{padding:8px 16px;flex-shrink:0;}
.pp-search{width:100%;box-sizing:border-box;padding:9px 14px 9px 34px;border-radius:11px;border:none;
 background:var(--pp-fill3);color:var(--pp-txt);font-size:15px;font-family:inherit;}
.pp-search::placeholder{color:var(--pp-txt3);}
.pp-search:focus{outline:none;background:var(--pp-fill2);}
.pp-search-ico{position:absolute;margin:9px 0 0 11px;pointer-events:none;color:var(--pp-txt3);}
.pp-search-ico svg{width:15px;height:15px;}

/* ══ notes row ══ */
.pp-notes-row{display:flex;gap:13px;padding:12px 16px 12px;overflow-x:auto;scrollbar-width:none;
 border-bottom:.5px solid var(--pp-sep);flex-shrink:0;}
.pp-notes-row::-webkit-scrollbar{display:none;}
.pp-note-item{flex-shrink:0;display:flex;flex-direction:column;align-items:center;gap:6px;cursor:pointer;width:66px;}
.pp-note-av-wrap{position:relative;margin-top:24px;}
.pp-note-bubble{position:absolute;bottom:calc(100% - 3px);left:50%;transform:translateX(-50%);
 background:var(--pp-glass2);color:var(--pp-txt);font-size:11px;line-height:1.25;padding:5px 9px;border-radius:13px;
 white-space:nowrap;max-width:98px;overflow:hidden;text-overflow:ellipsis;
 box-shadow:0 2px 10px rgba(0,0,0,.32);backdrop-filter:blur(14px);}
.pp-note-bubble::after{content:'';position:absolute;bottom:-4px;left:50%;transform:translateX(-50%);width:8px;height:8px;
 border-radius:50%;background:var(--pp-glass2);box-shadow:-5px 3px 0 -2px var(--pp-glass2);}
.pp-note-add{opacity:.5;}
.pp-note-name{font-size:11px;color:var(--pp-txt3);max-width:66px;overflow:hidden;text-overflow:ellipsis;
 white-space:nowrap;text-align:center;}
.pp-note-sep{flex-shrink:0;width:1px;align-self:stretch;margin:24px 2px 0;background:var(--pp-sep);position:relative;}
.pp-note-sep::before{content:attr(data-label);position:absolute;top:-20px;left:50%;transform:translateX(-50%);
 font-size:10px;color:var(--pp-txt3);white-space:nowrap;}

/* ══ chat ══ */
.pp-chat-header{min-height:50px;flex-shrink:0;display:flex;align-items:center;padding:0 8px;
 background:var(--pp-glass);backdrop-filter:blur(30px) saturate(1.8);-webkit-backdrop-filter:blur(30px) saturate(1.8);
 border-bottom:.5px solid var(--pp-sep);z-index:20;}
.pp-chat-hdr-center{flex:1;display:flex;align-items:center;justify-content:center;gap:8px;min-width:0;}
.pp-chat-hdr-name{font-size:16px;font-weight:600;color:var(--pp-txt);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.pp-star-banner{flex-shrink:0;display:flex;align-items:center;gap:8px;padding:8px 16px;background:var(--pp-fill3);
 border-bottom:.5px solid var(--pp-sep);font-size:13px;color:var(--pp-txt2);cursor:pointer;}
.pp-star-banner svg{width:14px;height:14px;color:#ffd60a;flex-shrink:0;}
.pp-star-banner span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}

.pp-msgs{flex:1;overflow-y:auto;overscroll-behavior:contain;-webkit-overflow-scrolling:touch;
 padding:12px 14px 10px;display:flex;flex-direction:column;gap:2px;}
.pp-sys{text-align:center;font-size:12px;color:var(--pp-txt3);margin:14px auto;max-width:76%;line-height:1.6;}
.pp-time-divider{align-self:center;font-size:12px;color:var(--pp-txt3);font-weight:600;margin:16px auto 6px;}
.pp-brow{display:flex;align-items:flex-end;max-width:80%;margin-top:2px;transition:transform .2s var(--pp-ease);}
.pp-brow:not(.grp){margin-top:9px;}
.pp-brow.out{align-self:flex-end;}
.pp-brow.in{align-self:flex-start;}
.pp-brow.grpmode{gap:6px;}
.pp-brow-col{display:flex;flex-direction:column;min-width:0;}
.pp-brow.out .pp-brow-col{align-items:flex-end;}
.pp-grp-msg-av{width:28px;flex-shrink:0;align-self:flex-end;}
.pp-grp-msg-av.empty{visibility:hidden;}
.pp-grp-sender{font-size:11px;color:var(--pp-txt3);font-weight:600;margin:0 0 2px 4px;}
.pp-bubble{padding:8px 14px;border-radius:20px;font-size:16px;line-height:1.4;word-break:break-word;max-width:100%;
 box-shadow:0 1px 2px rgba(0,0,0,.14);animation:pp-pop .26s var(--pp-spring);position:relative;cursor:pointer;}
.pp-brow.out .pp-bubble{background:var(--pp-mybub,var(--pp-accent));color:var(--pp-mytext,#fff);}
#pp-scr-chat.has-bubimg .pp-brow.out .pp-bubble{background-image:var(--pp-bubimg);background-size:cover;background-position:center;}
#pp-scr-chat.bub-glass .pp-brow.out .pp-bubble{background:rgba(120,120,128,.3)!important;
 backdrop-filter:blur(18px) saturate(1.6);-webkit-backdrop-filter:blur(18px) saturate(1.6);
 border:.5px solid rgba(255,255,255,.17);color:var(--pp-mytext,#fff);}
.pp-brow.in .pp-bubble{background:var(--pp-bub-in);color:var(--pp-txt);
 backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);}
.pp-brow.out .pp-bubble.tail{border-bottom-right-radius:6px;}
.pp-brow.in .pp-bubble.tail{border-bottom-left-radius:6px;}
#pp-scr-chat[data-tail="sharp"] .pp-bubble{border-radius:12px;}
#pp-scr-chat[data-tail="pill"] .pp-bubble{border-radius:22px;}
#pp-scr-chat[data-tail="pill"] .pp-bubble.tail{border-radius:22px;}
@keyframes pp-pop{from{opacity:0;transform:scale(.94) translateY(4px)}to{opacity:1;transform:none}}
.pp-msg-meta{display:flex;align-items:center;gap:5px;font-size:10px;color:var(--pp-txt3);margin:2px 6px 0;}
.pp-msg-meta svg{width:11px;height:11px;color:#ffd60a;}
.pp-warp-hl{animation:pp-warp 1.6s var(--pp-ease);}
@keyframes pp-warp{0%,100%{background:transparent}28%{background:rgba(10,132,255,.2);border-radius:14px}}

/* reply head */
.pp-reply-head{border-left:3px solid rgba(255,255,255,.45);padding:2px 0 4px 8px;margin:-2px 0 5px;opacity:.9;cursor:pointer;}
.pp-brow.in .pp-reply-head{border-left-color:var(--pp-accent);}
.pp-reply-head-label{font-size:10px;font-weight:700;opacity:.75;margin-bottom:1px;display:flex;align-items:center;gap:3px;}
.pp-reply-head-label svg{width:10px;height:10px;}
.pp-reply-head-txt{font-size:12px;line-height:1.35;opacity:.8;overflow:hidden;text-overflow:ellipsis;
 display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;}

/* image / voice / sticker / poll / location / transfer / contact card */
.pp-bubble-img{padding:4px!important;overflow:hidden;}
.pp-img-msg{border-radius:15px;overflow:hidden;background:rgba(0,0,0,.2);min-width:120px;min-height:80px;display:flex;}
.pp-img-thumb{max-width:224px;width:100%;height:auto;display:block;border-radius:15px;object-fit:cover;}
.pp-img-cap{font-size:14px;line-height:1.38;padding:6px 8px 2px;}
.pp-bubble-sticker{padding:0!important;background:transparent!important;box-shadow:none!important;}
.pp-sticker-img{width:118px;height:118px;object-fit:contain;display:block;filter:drop-shadow(0 3px 10px rgba(0,0,0,.35));}
.pp-bubble-voice{padding:8px 12px!important;}
.pp-voice{display:flex;align-items:center;gap:8px;min-width:136px;}
.pp-voice-play{width:26px;height:26px;border-radius:50%;background:rgba(255,255,255,.24);display:flex;
 align-items:center;justify-content:center;flex-shrink:0;}
.pp-voice-play svg{width:13px;height:13px;}
.pp-brow.in .pp-voice-play{background:var(--pp-accent);color:#fff;}
.pp-voice-wave{display:flex;align-items:center;gap:2px;flex:1;height:22px;}
.pp-voice-wave i{width:3px;border-radius:2px;background:currentColor;opacity:.55;}
.pp-voice-wave i:nth-child(1){height:8px}.pp-voice-wave i:nth-child(2){height:16px}.pp-voice-wave i:nth-child(3){height:11px}
.pp-voice-wave i:nth-child(4){height:20px}.pp-voice-wave i:nth-child(5){height:9px}.pp-voice-wave i:nth-child(6){height:15px}
.pp-voice-wave i:nth-child(7){height:7px}.pp-voice-wave i:nth-child(8){height:13px}
.pp-voice-dur{font-size:12px;opacity:.8;flex-shrink:0;font-variant-numeric:tabular-nums;}
.pp-loc{display:flex;align-items:center;gap:10px;min-width:180px;}
.pp-loc-map{width:44px;height:44px;border-radius:12px;flex-shrink:0;display:flex;align-items:center;justify-content:center;
 background:linear-gradient(150deg,#34c759,#0a84ff);color:#fff;}
.pp-loc-map svg{width:20px;height:20px;}
.pp-loc-name{font-size:15px;font-weight:600;}
.pp-loc-note{font-size:12px;opacity:.75;margin-top:1px;}
.pp-contactcard{display:flex;align-items:center;gap:10px;min-width:180px;}
.pp-contactcard-meta{min-width:0;}
.pp-contactcard-name{font-size:15px;font-weight:600;}
.pp-contactcard-sub{font-size:12px;opacity:.7;}
.pp-poll{min-width:210px;}
.pp-poll-q{font-size:15px;font-weight:600;margin-bottom:8px;}
.pp-poll-opt{position:relative;border-radius:11px;overflow:hidden;background:rgba(255,255,255,.12);
 margin-bottom:6px;cursor:pointer;}
.pp-poll-fill{position:absolute;inset:0;background:rgba(255,255,255,.2);width:0;transition:width .4s var(--pp-ease);}
.pp-poll-lb{position:relative;display:flex;justify-content:space-between;padding:8px 11px;font-size:14px;}
.pp-poll-total{font-size:11px;opacity:.7;margin-top:2px;}
.pp-transfer{border-radius:20px;padding:13px 16px;max-width:244px;cursor:pointer;color:#fff;
 background:linear-gradient(155deg,#30d158,#22a148);box-shadow:0 6px 20px rgba(48,209,88,.28);}
.pp-transfer.in{background:linear-gradient(155deg,#0a84ff,#0060df);box-shadow:0 6px 20px rgba(10,132,255,.28);}
.pp-transfer.declined{background:linear-gradient(155deg,#6c6c70,#48484a);box-shadow:none;opacity:.85;}
.pp-transfer-top{display:flex;align-items:center;gap:6px;font-size:12px;font-weight:600;opacity:.92;}
.pp-transfer-top svg{width:14px;height:14px;}
.pp-transfer-amt{font-size:27px;font-weight:800;margin:5px 0 2px;letter-spacing:-.6px;}
.pp-transfer-note{font-size:13px;opacity:.9;margin-bottom:4px;}
.pp-transfer-status{font-size:11px;opacity:.8;}
.pp-transfer-acts{display:flex;gap:8px;margin-top:10px;}
.pp-transfer-acts button{flex:1;border:none;border-radius:12px;padding:8px;font-size:13px;font-weight:600;cursor:pointer;}
.pp-transfer-decline{background:rgba(0,0,0,.24);color:#fff;}
.pp-transfer-accept{background:#fff;color:#0a84ff;}
.pp-callmsg{display:flex;align-items:center;gap:10px;padding:9px 14px;border-radius:19px;max-width:100%;cursor:pointer;}
.pp-callmsg.out{background:var(--pp-mybub,var(--pp-accent));color:var(--pp-mytext,#fff);border-bottom-right-radius:6px;}
.pp-callmsg.in{background:var(--pp-bub-in);color:var(--pp-txt);border-bottom-left-radius:6px;}
.pp-callmsg-ic{width:30px;height:30px;border-radius:50%;background:rgba(255,255,255,.2);display:flex;
 align-items:center;justify-content:center;flex-shrink:0;}
.pp-callmsg-ic svg{width:15px;height:15px;}
.pp-callmsg.in .pp-callmsg-ic{background:rgba(48,209,88,.24);color:#30d158;}
.pp-callmsg.missed .pp-callmsg-ic{background:rgba(255,69,58,.24);color:#ff453a;}
.pp-callmsg-body{display:flex;flex-direction:column;min-width:0;}
.pp-callmsg-title{font-size:14px;font-weight:600;}
.pp-callmsg.missed .pp-callmsg-title{color:#ff453a;}
.pp-callmsg-sub{font-size:12px;opacity:.72;}
.pp-bubble-shared{padding:0!important;background:transparent!important;box-shadow:none!important;overflow:visible;position:relative;}
.pp-shared-card{background:var(--pp-fill3);border:.5px solid var(--pp-sep);border-radius:16px;overflow:hidden;
 max-width:252px;cursor:pointer;}
.pp-shared-top{display:flex;align-items:center;gap:8px;padding:9px 10px 5px;}
.pp-shared-name{font-size:12px;font-weight:700;color:var(--pp-txt);flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;}
.pp-shared-more{background:none;border:none;color:var(--pp-txt3);cursor:pointer;padding:2px;display:flex;}
.pp-shared-more svg{width:15px;height:15px;}
.pp-shared-text{font-size:13px;line-height:1.42;padding:2px 10px 8px;color:var(--pp-txt);}
.pp-shared-img{width:100%;height:132px;background:#000 center/cover no-repeat;background-color:var(--pp-sep);}
.pp-shared-gone{padding:15px;font-size:13px;color:var(--pp-txt3);text-align:center;}

.pp-regen-row{align-self:flex-start;margin:5px 0 2px;}
.pp-regen{display:inline-flex;align-items:center;gap:5px;background:var(--pp-fill3);border:.5px solid var(--pp-sep);
 color:var(--pp-txt3);font-size:12px;border-radius:15px;padding:5px 12px;cursor:pointer;font-family:inherit;}
.pp-regen svg{width:13px;height:13px;}
.pp-regen:active{transform:scale(.94);}
.pp-loadmore{display:flex;justify-content:center;padding:6px 0 10px;}
.pp-typing{display:flex;gap:5px;padding:12px 15px;background:var(--pp-bub-in);border-radius:20px;
 border-bottom-left-radius:6px;width:fit-content;backdrop-filter:blur(12px);margin-top:6px;}
.pp-typing span{width:8px;height:8px;border-radius:50%;background:var(--pp-txt3);animation:pp-bounce .9s infinite ease-in-out;}
.pp-typing span:nth-child(2){animation-delay:.15s;}
.pp-typing span:nth-child(3){animation-delay:.3s;}
@keyframes pp-bounce{0%,60%,100%{transform:translateY(0);opacity:.5}30%{transform:translateY(-6px);opacity:1}}

/* input bar */
.pp-inputbar{flex-shrink:0;display:flex;align-items:flex-end;gap:7px;padding:8px 11px;
 background:var(--pp-glass);backdrop-filter:blur(30px) saturate(1.8);-webkit-backdrop-filter:blur(30px) saturate(1.8);
 border-top:.5px solid var(--pp-sep);}
.pp-round-btn{flex-shrink:0;width:36px;height:36px;border-radius:50%;border:none;background:var(--pp-fill2);
 color:var(--pp-txt);cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0;
 transition:transform .14s var(--pp-spring);}
.pp-round-btn:active{transform:scale(.86);}
.pp-round-btn svg{width:18px;height:18px;}
.pp-input{flex:1;background:var(--pp-fill3);border:.5px solid var(--pp-sep);border-radius:20px;padding:9px 15px;
 font-size:16px;color:var(--pp-txt);resize:none;line-height:1.4;max-height:104px;font-family:inherit;}
.pp-input:focus{outline:none;border-color:rgba(255,255,255,.2);}
.pp-input::placeholder{color:var(--pp-txt3);}
.pp-gen{flex-shrink:0;width:36px;height:36px;border-radius:50%;border:none;background:var(--pp-accent);color:#fff;
 cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0;
 box-shadow:0 2px 12px rgba(0,0,0,.3);transition:transform .14s var(--pp-spring),filter .15s;}
.pp-gen:active{transform:scale(.86);}
.pp-gen:disabled{filter:grayscale(.6) brightness(.7);cursor:default;}
.pp-gen svg{width:19px;height:19px;}
.pp-stop{background:#ff453a!important;}
.pp-stop svg{width:16px;height:16px;}

/* sticker tray */
.pp-sticker-tray{flex-shrink:0;max-height:0;overflow:hidden;background:var(--pp-glass);
 border-top:.5px solid var(--pp-sep);transition:max-height .3s var(--pp-ease);}
.pp-sticker-tray.show{max-height:220px;overflow-y:auto;}
.pp-sticker-packs{display:flex;gap:6px;padding:8px 12px 4px;overflow-x:auto;scrollbar-width:none;}
.pp-sticker-packs::-webkit-scrollbar{display:none;}
.pp-sticker-packs button{flex-shrink:0;background:var(--pp-fill3);border:none;color:var(--pp-txt2);font-size:12px;
 padding:5px 12px;border-radius:14px;cursor:pointer;font-family:inherit;}
.pp-sticker-packs button.on{background:var(--pp-accent);color:#fff;}
.pp-sticker-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;padding:8px 12px 14px;}
.pp-sticker-cell{aspect-ratio:1;border:none;background:var(--pp-fill3);border-radius:14px;cursor:pointer;padding:5px;
 display:flex;align-items:center;justify-content:center;overflow:hidden;transition:transform .14s var(--pp-spring);}
.pp-sticker-cell:active{transform:scale(.9);}
.pp-sticker-cell img{width:100%;height:100%;object-fit:contain;}

/* ══ settings panels ══ */
.pp-body{flex:1;overflow-y:auto;overscroll-behavior:contain;-webkit-overflow-scrolling:touch;padding:12px 16px 26px;}
.pp-sec-label{font-size:12px;color:var(--pp-txt3);margin:16px 4px 7px;text-transform:uppercase;letter-spacing:.5px;
 display:flex;align-items:center;gap:7px;}
.pp-card{background:var(--pp-card);border:.5px solid var(--pp-sep2);border-radius:16px;overflow:hidden;margin-bottom:6px;
 backdrop-filter:blur(16px);}
.pp-cell{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 14px;font-size:15px;
 color:var(--pp-txt);border-bottom:.5px solid var(--pp-sep2);min-height:44px;}
.pp-cell:last-child{border-bottom:none;}
.pp-cell.tap{cursor:pointer;}
.pp-cell.tap:active{background:var(--pp-fill3);}
.pp-cell-lb{flex:1;min-width:0;display:flex;align-items:center;gap:8px;}
.pp-cell-lb svg{width:17px;height:17px;color:var(--pp-txt3);flex-shrink:0;}
.pp-cell-val{color:var(--pp-txt3);font-size:14px;flex-shrink:0;display:flex;align-items:center;gap:5px;}
.pp-cell-val svg{width:14px;height:14px;}
.pp-cell-col{display:block;}
.pp-hint{font-size:12px;color:var(--pp-txt3);line-height:1.55;margin:5px 6px 12px;}
.pp-input-line{width:100%;box-sizing:border-box;background:var(--pp-fill3);border:none;border-radius:13px;
 padding:11px 14px;color:var(--pp-txt);font-size:15px;font-family:inherit;}
.pp-input-line:focus{outline:none;background:var(--pp-fill2);}
textarea.pp-input-line{resize:none;line-height:1.45;}
.pp-btn{background:var(--pp-fill2);border:none;border-radius:14px;padding:10px 16px;color:var(--pp-txt);
 font-size:14px;font-weight:600;cursor:pointer;font-family:inherit;transition:transform .14s var(--pp-spring);}
.pp-btn:active{transform:scale(.96);}
.pp-btn.primary{background:var(--pp-accent);color:#fff;}
.pp-btn.danger{background:rgba(255,69,58,.9);color:#fff;}
.pp-btn.wide{width:100%;}
.pp-btn.on{background:var(--pp-accent);color:#fff;}
.pp-btn svg{width:15px;height:15px;vertical-align:-2px;margin-right:4px;}
.pp-btn-row{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;}
.pp-switch{position:relative;width:48px;height:29px;flex-shrink:0;}
.pp-switch input{opacity:0;width:0;height:0;}
.pp-switch span{position:absolute;inset:0;background:var(--pp-fill1);border-radius:15px;transition:.3s;cursor:pointer;}
.pp-switch span::before{content:'';position:absolute;width:25px;height:25px;left:2px;top:2px;background:#fff;
 border-radius:50%;transition:.3s var(--pp-spring);box-shadow:0 1px 4px rgba(0,0,0,.3);}
.pp-switch input:checked+span{background:var(--pp-accent);}
.pp-switch input:checked+span::before{transform:translateX(19px);}
.pp-sel{background:var(--pp-fill3);border:none;color:var(--pp-txt);border-radius:10px;padding:7px 10px;
 font-size:14px;font-family:inherit;max-width:58%;}
.pp-num{width:74px;background:var(--pp-fill3);border:none;color:var(--pp-txt);border-radius:10px;padding:7px 10px;
 font-size:14px;text-align:center;font-family:inherit;}
input[type=range]{accent-color:var(--pp-accent);}
.pp-swatches{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:6px;}
.pp-swatch{width:42px;height:42px;border-radius:12px;cursor:pointer;border:2px solid transparent;padding:0;
 background-size:cover;background-position:center;color:var(--pp-txt);font-size:10px;
 display:flex;align-items:center;justify-content:center;transition:transform .14s var(--pp-spring);}
.pp-swatch:active{transform:scale(.9);}
.pp-swatch.on{border-color:var(--pp-accent);transform:scale(1.06);}
.pp-upload{display:inline-flex;align-items:center;gap:6px;background:var(--pp-fill2);color:var(--pp-txt);
 border-radius:14px;padding:9px 14px;font-size:14px;cursor:pointer;}
.pp-upload svg{width:15px;height:15px;}
.pp-color-wrap{position:relative;display:inline-flex;align-items:center;gap:7px;background:var(--pp-fill2);
 border-radius:14px;padding:6px 12px;cursor:pointer;font-size:13px;color:var(--pp-txt);}
.pp-color-wrap input[type=color]{width:26px;height:26px;border:none;background:none;padding:0;cursor:pointer;border-radius:50%;}
.pp-chip{display:inline-flex;align-items:center;gap:6px;background:var(--pp-fill2);border-radius:16px;
 padding:4px 11px 4px 4px;font-size:13px;color:var(--pp-txt);margin:4px 4px 0 0;}
.pp-chips{display:flex;flex-wrap:wrap;margin-top:4px;}
.pp-persona-opt{display:flex;align-items:center;gap:10px;width:100%;background:var(--pp-fill3);
 border:1.5px solid transparent;border-radius:14px;padding:10px 14px;color:var(--pp-txt);font-size:14px;
 cursor:pointer;text-align:left;margin-bottom:6px;font-family:inherit;}
.pp-persona-opt.on{border-color:var(--pp-accent);}
.pp-persona-opt svg{margin-left:auto;color:var(--pp-accent);flex-shrink:0;width:16px;height:16px;}
.pp-persona-opt-av{width:30px;height:30px;border-radius:50%;object-fit:cover;background:var(--pp-fill2);flex-shrink:0;}
.pp-persona-opt-lb{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}

/* ══ feed ══ */
.pp-feed-scroll{flex:1;overflow-y:auto;overscroll-behavior:contain;-webkit-overflow-scrolling:touch;}
.pp-story-tray{display:flex;gap:11px;padding:12px 14px;overflow-x:auto;scrollbar-width:none;
 border-bottom:.5px solid var(--pp-sep);}
.pp-story-tray::-webkit-scrollbar{display:none;}
.pp-story-cell{flex-shrink:0;display:flex;flex-direction:column;align-items:center;gap:6px;cursor:pointer;width:74px;}
.pp-story-ring{position:relative;width:72px;height:72px;border-radius:50%;display:flex;align-items:center;justify-content:center;padding:2.5px;}
.pp-story-ring.unseen{background:conic-gradient(from 0deg,#ff375f,#ff9f0a,#bf5af2,#ff375f);animation:pp-spin 7s linear infinite;}
.pp-story-ring.close{background:conic-gradient(from 0deg,#30d158,#a4f0b8,#30d158);}
.pp-story-ring.seen{background:var(--pp-sep);}
.pp-story-ring.add{background:var(--pp-fill2);}
@keyframes pp-spin{to{transform:rotate(360deg)}}
.pp-story-ring>*{border:2.5px solid rgba(12,12,16,.96);box-sizing:border-box;}
#pp-frame.light .pp-story-ring>*{border-color:rgba(255,255,255,.96);}
.pp-story-plus{position:absolute;bottom:-1px;right:-1px;width:23px;height:23px;border-radius:50%;
 background:var(--pp-accent);color:#fff;display:flex;align-items:center;justify-content:center;
 border:2px solid rgba(12,12,16,.96)!important;}
.pp-story-plus svg{width:13px;height:13px;}
.pp-story-cell-name{font-size:11px;color:var(--pp-txt3);max-width:72px;overflow:hidden;text-overflow:ellipsis;
 white-space:nowrap;text-align:center;}
.pp-feed-list{padding:6px 0 20px;}
.pp-post{padding:12px 0 4px;border-bottom:.5px solid var(--pp-sep);}
.pp-post-head{display:flex;align-items:center;gap:10px;padding:0 16px 9px;}
.pp-post-who{flex:1;min-width:0;display:flex;flex-direction:column;}
.pp-post-name{font-size:14px;font-weight:700;color:var(--pp-txt);display:flex;align-items:center;gap:4px;}
.pp-post-name svg{width:12px;height:12px;color:var(--pp-txt3);}
.pp-post-age{font-size:11px;color:var(--pp-txt3);}
.pp-post-more{background:none;border:none;color:var(--pp-txt3);cursor:pointer;padding:4px;display:flex;}
.pp-post-more svg{width:17px;height:17px;}
.pp-post-text{font-size:15px;line-height:1.52;color:var(--pp-txt);white-space:pre-wrap;word-break:break-word;
 cursor:pointer;padding:0 16px 9px;}
.pp-post-textbg{margin:0 16px 9px;border-radius:18px;padding:26px 20px;font-size:19px;font-weight:600;line-height:1.5;
 color:#fff;text-align:center;text-shadow:0 2px 12px rgba(0,0,0,.28);cursor:pointer;}
.pp-post-media{position:relative;margin-bottom:9px;}
.pp-post-img{width:100%;aspect-ratio:1/1;background:#000 center/cover no-repeat;background-color:var(--pp-fill3);}
.pp-carousel{display:flex;overflow-x:auto;scroll-snap-type:x mandatory;scrollbar-width:none;}
.pp-carousel::-webkit-scrollbar{display:none;}
.pp-carousel .pp-post-img{min-width:100%;scroll-snap-align:center;}
.pp-carousel-dots{position:absolute;bottom:9px;left:0;right:0;display:flex;justify-content:center;gap:5px;}
.pp-carousel-dots i{width:6px;height:6px;border-radius:50%;background:rgba(255,255,255,.45);}
.pp-carousel-dots i.on{background:#fff;}
.pp-post-hearts{position:absolute;inset:0;pointer-events:none;overflow:hidden;}
.pp-fly-heart{position:absolute;color:#ff375f;animation:pp-fly 1s var(--pp-ease) forwards;}
.pp-fly-heart svg{width:64px;height:64px;filter:drop-shadow(0 3px 12px rgba(0,0,0,.4));}
@keyframes pp-fly{0%{transform:scale(.3);opacity:0}22%{transform:scale(1.18);opacity:1}100%{transform:scale(1) translateY(-40px);opacity:0}}
.pp-post-actions{display:flex;align-items:center;gap:16px;padding:0 16px 6px;}
.pp-post-actions button{display:flex;align-items:center;gap:5px;background:none;border:none;color:var(--pp-txt2);
 font-size:14px;cursor:pointer;padding:4px 0;font-family:inherit;}
.pp-post-actions svg{width:21px;height:21px;}
.pp-post-actions .on{color:#ff375f;}
.pp-post-actions .saved{color:var(--pp-accent);}
.pp-post-actions .push{margin-left:auto;}
.pp-post-stats{padding:0 16px 8px;font-size:12px;color:var(--pp-txt3);display:flex;gap:12px;}
.pp-tag{color:var(--pp-accent);cursor:pointer;}
.pp-poll-post{padding:0 16px 10px;}
.pp-post-full{border-bottom:none;}
.pp-post-shared-note{margin:0 16px 8px;padding:8px 12px;background:var(--pp-fill3);border-radius:12px;
 font-size:12px;color:var(--pp-txt2);cursor:pointer;display:flex;align-items:center;gap:6px;}
.pp-post-shared-note svg{width:13px;height:13px;flex-shrink:0;}
.pp-cmt-head{font-size:13px;font-weight:700;color:var(--pp-txt3);padding:12px 16px 4px;}
.pp-cmt{display:flex;gap:10px;padding:8px 16px;}
.pp-cmt.child{padding-left:46px;}
.pp-cmt-body{flex:1;min-width:0;}
.pp-cmt-bubble{background:var(--pp-fill3);border-radius:15px;padding:8px 12px;cursor:pointer;}
.pp-cmt-name{font-size:13px;font-weight:700;color:var(--pp-txt);display:block;}
.pp-cmt-to{font-size:11px;color:var(--pp-accent);cursor:pointer;margin-right:4px;}
.pp-cmt-txt{font-size:14px;line-height:1.42;color:var(--pp-txt);word-break:break-word;}
.pp-cmt-meta{display:flex;align-items:center;gap:14px;padding:4px 12px 0;font-size:12px;color:var(--pp-txt3);}
.pp-cmt-meta button{background:none;border:none;color:var(--pp-txt3);font-size:12px;font-weight:600;cursor:pointer;
 padding:0;display:flex;align-items:center;gap:4px;font-family:inherit;}
.pp-cmt-meta svg{width:13px;height:13px;}
.pp-cmt-meta .on{color:#ff375f;}
.pp-fab-inpage{position:absolute;right:16px;bottom:74px;width:52px;height:52px;border-radius:30%;border:none;
 background:var(--pp-accent);color:#fff;cursor:pointer;display:flex;align-items:center;justify-content:center;
 box-shadow:0 8px 24px rgba(0,0,0,.42);z-index:50;padding:0;transition:transform .16s var(--pp-spring);}
.pp-fab-inpage:active{transform:scale(.9);}
.pp-fab-inpage svg{width:23px;height:23px;}
.pp-gridview{display:grid;grid-template-columns:repeat(3,1fr);gap:2px;padding:2px;}
.pp-gridcell{aspect-ratio:1;background:var(--pp-fill3) center/cover no-repeat;cursor:pointer;position:relative;
 display:flex;align-items:center;justify-content:center;overflow:hidden;}
.pp-gridcell-txt{font-size:11px;line-height:1.4;color:var(--pp-txt2);padding:8px;
 display:-webkit-box;-webkit-line-clamp:5;-webkit-box-orient:vertical;overflow:hidden;text-align:center;}
.pp-gridcell-badge{position:absolute;top:5px;right:5px;color:#fff;filter:drop-shadow(0 1px 3px rgba(0,0,0,.5));}
.pp-gridcell-badge svg{width:14px;height:14px;}
.pp-taglist{display:flex;flex-wrap:wrap;gap:7px;padding:12px 16px;}
.pp-taglist button{background:var(--pp-fill3);border:none;color:var(--pp-accent);font-size:13px;padding:6px 13px;
 border-radius:15px;cursor:pointer;font-family:inherit;}

/* profile */
.pp-prof-top{display:flex;align-items:center;gap:18px;padding:16px 18px 10px;}
.pp-prof-stats{flex:1;display:flex;justify-content:space-around;}
.pp-prof-stat{text-align:center;cursor:pointer;}
.pp-prof-stat b{display:block;font-size:17px;font-weight:700;}
.pp-prof-stat span{font-size:12px;color:var(--pp-txt3);}
.pp-prof-name{padding:0 18px;font-size:15px;font-weight:700;display:flex;align-items:center;gap:6px;}
.pp-prof-name svg{width:14px;height:14px;color:var(--pp-txt3);}
.pp-prof-handle{padding:1px 18px 0;font-size:13px;color:var(--pp-txt3);}
.pp-prof-bio{padding:6px 18px 0;font-size:14px;line-height:1.5;color:var(--pp-txt2);white-space:pre-wrap;}
.pp-prof-link{padding:4px 18px 0;font-size:13px;color:var(--pp-accent);display:flex;align-items:center;gap:5px;}
.pp-prof-link svg{width:13px;height:13px;}
.pp-prof-btns{display:flex;gap:8px;padding:12px 18px;}
.pp-highlights{display:flex;gap:12px;padding:4px 18px 12px;overflow-x:auto;scrollbar-width:none;}
.pp-highlights::-webkit-scrollbar{display:none;}
.pp-hl-cell{flex-shrink:0;width:64px;display:flex;flex-direction:column;align-items:center;gap:5px;cursor:pointer;}
.pp-hl-ring{width:62px;height:62px;border-radius:50%;border:1.5px solid var(--pp-sep);padding:3px;
 display:flex;align-items:center;justify-content:center;background:var(--pp-fill3) center/cover no-repeat;}
.pp-hl-name{font-size:11px;color:var(--pp-txt3);max-width:64px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}

/* ══ story viewer ══ */
#pp-story-viewer{position:absolute;inset:0;z-index:800;background:#000;overflow:hidden;display:none;}
.pp-sv-bars{position:absolute;top:9px;left:9px;right:9px;display:flex;gap:4px;z-index:4;}
.pp-sv-bar{flex:1;height:3px;border-radius:2px;background:rgba(255,255,255,.3);overflow:hidden;}
.pp-sv-bar i{display:block;height:100%;width:0;background:#fff;border-radius:2px;}
.pp-sv-bar i.done{width:100%;}
@keyframes pp-sv-fill{from{width:0}to{width:100%}}
.pp-sv-top{position:absolute;top:22px;left:12px;right:12px;display:flex;align-items:center;justify-content:space-between;z-index:4;}
.pp-sv-who{display:flex;align-items:center;gap:8px;min-width:0;}
.pp-sv-name{font-size:14px;font-weight:700;color:#fff;text-shadow:0 1px 4px rgba(0,0,0,.6);}
.pp-sv-age{font-size:12px;color:rgba(255,255,255,.7);}
.pp-sv-tools{display:flex;gap:2px;}
.pp-sv-tools button{background:none;border:none;color:#fff;cursor:pointer;padding:7px;display:flex;}
.pp-sv-tools svg{width:17px;height:17px;}
.pp-sv-body{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;}
.pp-sv-img{position:absolute;inset:0;background-size:cover;background-position:center;background-repeat:no-repeat;}
.pp-sv-cap{position:absolute;bottom:98px;left:20px;right:20px;z-index:3;font-size:16px;line-height:1.5;color:#fff;
 text-align:center;text-shadow:0 2px 12px rgba(0,0,0,.8);}
.pp-sv-text{width:100%;height:100%;display:flex;align-items:center;justify-content:center;padding:44px 28px;
 box-sizing:border-box;font-size:25px;font-weight:600;line-height:1.5;text-align:center;
 text-shadow:0 2px 14px rgba(0,0,0,.3);}
.pp-sv-tap{position:absolute;top:66px;bottom:92px;width:30%;background:none;border:none;cursor:pointer;z-index:3;}
.pp-sv-tap.prev{left:0;}
.pp-sv-tap.next{right:0;}
.pp-sv-footer{position:absolute;bottom:0;left:0;right:0;padding:14px 16px calc(14px + env(safe-area-inset-bottom));
 display:flex;gap:10px;z-index:4;background:linear-gradient(0deg,rgba(0,0,0,.55),transparent);}
.pp-sv-btn{flex:1;background:rgba(255,255,255,.16);border:none;color:#fff;border-radius:18px;padding:11px;
 font-size:14px;cursor:pointer;backdrop-filter:blur(12px);display:flex;align-items:center;justify-content:center;gap:6px;
 font-family:inherit;}
.pp-sv-btn svg{width:15px;height:15px;}
.pp-sv-btn.danger{background:rgba(255,69,58,.85);flex:0 0 auto;padding:11px 16px;}
.pp-sv-reply-bar{position:absolute;bottom:0;left:0;right:0;padding:14px 16px calc(14px + env(safe-area-inset-bottom));
 display:flex;align-items:center;gap:10px;z-index:4;background:linear-gradient(0deg,rgba(0,0,0,.55),transparent);}
.pp-sv-reply-input{flex:1;background:rgba(255,255,255,.14);border:1px solid rgba(255,255,255,.3);border-radius:20px;
 padding:10px 16px;color:#fff;font-size:15px;backdrop-filter:blur(12px);font-family:inherit;}
.pp-sv-reply-input:focus{outline:none;border-color:#fff;}
.pp-sv-reply-input::placeholder{color:rgba(255,255,255,.6);}
.pp-sv-like{width:42px;height:42px;border-radius:50%;background:rgba(255,255,255,.16);border:none;color:#fff;
 cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;backdrop-filter:blur(12px);padding:0;}
.pp-sv-like svg{width:20px;height:20px;}
.pp-sv-like.on{color:#ff375f;}
.pp-sv-viewers{position:absolute;left:0;right:0;bottom:0;max-height:62%;background:var(--pp-sheet);
 border-radius:22px 22px 0 0;z-index:6;transform:translateY(100%);transition:transform .34s var(--pp-spring);
 display:flex;flex-direction:column;padding-bottom:env(safe-area-inset-bottom);}
.pp-sv-viewers.show{transform:none;}
.pp-sv-viewers-head{padding:14px 18px 10px;font-size:15px;font-weight:700;color:var(--pp-txt);
 display:flex;align-items:center;justify-content:space-between;}
.pp-sv-viewers-list{flex:1;overflow-y:auto;}
.pp-sv-grab{width:38px;height:4px;border-radius:3px;background:var(--pp-fill1);margin:8px auto 0;}

/* ══ call ══ */
#pp-scr-call,#pp-scr-callend{background:#000;}
.pp-call-bg{position:absolute!important;inset:0!important;z-index:0!important;background-color:#12121a;
 background-size:cover!important;background-position:center!important;background-repeat:no-repeat!important;
 filter:blur(30px) brightness(.68) saturate(1.15);transform:scale(1.28);pointer-events:none;}
.pp-call-bg.no-img{filter:none;transform:none;background:radial-gradient(120% 90% at 50% 0%,#2a2a33,#08080b 70%)!important;}
.pp-call-bg::after{content:'';position:absolute;inset:0;
 background:linear-gradient(180deg,rgba(10,10,18,.22),rgba(10,10,18,.44) 55%,rgba(10,10,18,.74));}
.pp-call-top{position:relative;z-index:1;display:flex;flex-direction:column;align-items:center;gap:5px;padding:44px 0 6px;}
.pp-call-sub{font-size:14px;color:rgba(235,235,245,.7);letter-spacing:.2px;}
.pp-call-name{font-size:31px;font-weight:600;color:#fff;text-shadow:0 2px 14px rgba(0,0,0,.5);}
.pp-call-status{font-size:15px;color:rgba(235,235,245,.72);transition:opacity .4s;}
.pp-call-dur{font-size:17px;color:rgba(235,235,245,.9);font-variant-numeric:tabular-nums;}
#pp-call-av{margin-top:14px;}
.pp-call-stage{position:relative;z-index:1;flex:1;display:flex;flex-direction:column;align-items:center;
 justify-content:center;padding:20px 30px;gap:14px;overflow:hidden;text-align:center;}
.pp-call-line{font-size:23px;line-height:1.5;color:#fff;text-shadow:0 2px 18px rgba(0,0,0,.8);opacity:0;
 transform:translateY(14px);transition:opacity .6s,transform .6s;max-width:100%;font-weight:500;}
.pp-call-line.me{font-size:17px;color:rgba(235,235,245,.6);font-weight:400;}
.pp-call-line.show{opacity:1;transform:none;}
.pp-call-line.fade{opacity:0;transform:translateY(-12px);}
.pp-call-typing{position:relative;z-index:1;display:none;gap:5px;align-self:center;margin:0 auto 8px;padding:10px 16px;
 background:rgba(255,255,255,.14);border-radius:16px;width:fit-content;backdrop-filter:blur(12px);}
.pp-call-typing.show{display:flex;}
.pp-call-typing span{width:8px;height:8px;border-radius:50%;background:rgba(255,255,255,.85);animation:pp-bounce .9s infinite ease-in-out;}
.pp-call-typing span:nth-child(2){animation-delay:.15s;}
.pp-call-typing span:nth-child(3){animation-delay:.3s;}
.pp-call-inputbar{position:relative;z-index:1;display:flex;align-items:flex-end;gap:8px;padding:6px 16px;}
.pp-call-input{flex:1;background:rgba(255,255,255,.14);border:none;border-radius:20px;padding:10px 16px;color:#fff;
 font-size:16px;resize:none;line-height:1.4;max-height:80px;font-family:inherit;backdrop-filter:blur(12px);}
.pp-call-input:focus{outline:none;}
.pp-call-input::placeholder{color:rgba(235,235,245,.5);}
.pp-call-ctrls{position:relative;z-index:1;padding:12px 0 calc(30px + env(safe-area-inset-bottom));}
.pp-call-active-ctrls{display:flex;align-items:center;justify-content:center;gap:32px;}
.pp-cc{background:none;border:none;cursor:pointer;display:flex;flex-direction:column;align-items:center;gap:6px;
 color:#fff;font-size:11px;padding:0;font-family:inherit;}
.pp-cc-ic{width:62px;height:62px;border-radius:50%;display:flex;align-items:center;justify-content:center;
 background:rgba(255,255,255,.16);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);transition:background .15s;}
.pp-cc-ic svg{width:24px;height:24px;}
.pp-cc.on .pp-cc-ic{background:#fff;color:#000;}
.pp-cc-lb{color:rgba(235,235,245,.85);}
.pp-call-end{width:62px;height:62px;border-radius:50%;background:#ff453a;border:none;color:#fff;cursor:pointer;
 display:flex;align-items:center;justify-content:center;box-shadow:0 6px 22px rgba(255,69,58,.5);
 transition:transform .14s var(--pp-spring);padding:0;}
.pp-call-end svg{width:26px;height:26px;}
.pp-call-end:active{transform:scale(.9);}
.pp-call-answer{display:none;align-items:flex-end;justify-content:space-around;padding:0 20px;}
.pp-ans-btn{background:none;border:none;cursor:pointer;display:flex;flex-direction:column;align-items:center;gap:8px;
 color:#fff;font-size:12px;padding:0;font-family:inherit;}
.pp-ans-btn .pp-ans-ic{width:66px;height:66px;border-radius:50%;display:flex;align-items:center;justify-content:center;}
.pp-ans-btn svg{width:28px;height:28px;}
.pp-ans-btn.decline .pp-ans-ic{background:#ff453a;box-shadow:0 6px 22px rgba(255,69,58,.5);}
.pp-ans-btn.accept .pp-ans-ic{background:#30d158;box-shadow:0 6px 22px rgba(48,209,88,.5);}
.pp-ans-btn:active .pp-ans-ic{transform:scale(.92);}
#pp-scr-call.ringing .pp-call-active-ctrls{display:none;}
#pp-scr-call.ringing .pp-call-answer{display:flex;}
#pp-scr-call.ringing .pp-call-inputbar,#pp-scr-call.ringing .pp-call-stage,#pp-scr-call.ringing .pp-call-typing{display:none;}
#pp-scr-call.ringing .pp-call-top{flex:1;justify-content:center;}
.pp-calllog-row{display:flex;align-items:center;gap:13px;padding:11px 16px;cursor:pointer;border-bottom:.5px solid var(--pp-sep2);}
.pp-calllog-row:active{background:var(--pp-fill3);}
.pp-transcript-body{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:8px;}

/* ══ wallet ══ */
.pp-wallet-body{flex:1;overflow-y:auto;overscroll-behavior:contain;padding:14px 16px 26px;}
.pp-wcard{position:relative;border-radius:24px;padding:20px;color:#fff;overflow:hidden;
 background:linear-gradient(148deg,rgba(94,92,230,.92),rgba(10,132,255,.86) 52%,rgba(48,209,88,.72));
 box-shadow:0 16px 40px rgba(0,0,0,.42),inset 0 1px 0 rgba(255,255,255,.28);}
.pp-wcard::before{content:'';position:absolute;top:-46%;right:-22%;width:230px;height:230px;border-radius:50%;
 background:radial-gradient(circle,rgba(255,255,255,.26),transparent 70%);}
.pp-wcard::after{content:'';position:absolute;inset:0;backdrop-filter:blur(2px);pointer-events:none;}
.pp-wcard>*{position:relative;z-index:1;}
.pp-wcard-top{display:flex;align-items:center;justify-content:space-between;}
.pp-wcard-lb{font-size:12px;font-weight:700;opacity:.88;letter-spacing:.6px;text-transform:uppercase;}
.pp-wcard-top svg{width:22px;height:22px;opacity:.9;}
.pp-wcard-bal{font-size:35px;font-weight:800;margin:14px 0 4px;letter-spacing:-1.2px;}
.pp-wcard-chg{font-size:12px;opacity:.85;display:flex;align-items:center;gap:4px;}
.pp-wcard-chg svg{width:12px;height:12px;}
.pp-wcard-foot{display:flex;align-items:center;justify-content:space-between;font-size:13px;opacity:.86;margin-top:14px;}
.pp-wcard-acc{font-variant-numeric:tabular-nums;letter-spacing:1.4px;}
.pp-wacts{display:flex;gap:9px;margin:14px 0;}
.pp-wact{flex:1;display:flex;flex-direction:column;align-items:center;gap:6px;background:var(--pp-card);
 border:.5px solid var(--pp-sep2);border-radius:18px;padding:13px 6px;color:var(--pp-txt);font-size:12px;
 font-weight:600;cursor:pointer;font-family:inherit;backdrop-filter:blur(16px);
 transition:transform .16s var(--pp-spring);}
.pp-wact:active{transform:scale(.94);}
.pp-wact svg{width:21px;height:21px;color:var(--pp-accent);}
.pp-wchart{background:var(--pp-card);border:.5px solid var(--pp-sep2);border-radius:18px;padding:14px;margin-bottom:8px;}
.pp-wchart-head{display:flex;align-items:center;justify-content:space-between;font-size:13px;font-weight:600;
 color:var(--pp-txt2);margin-bottom:12px;}
.pp-wchart-bars{display:flex;align-items:flex-end;gap:7px;height:88px;}
.pp-wbar{flex:1;display:flex;flex-direction:column;align-items:center;gap:5px;height:100%;justify-content:flex-end;}
.pp-wbar-stack{width:100%;display:flex;flex-direction:column;justify-content:flex-end;gap:2px;height:100%;}
.pp-wbar-in{background:linear-gradient(180deg,#30d158,#22a148);border-radius:4px 4px 0 0;min-height:2px;}
.pp-wbar-out{background:linear-gradient(180deg,#ff6482,#ff375f);border-radius:0 0 4px 4px;min-height:2px;}
.pp-wbar-lb{font-size:10px;color:var(--pp-txt3);}
.pp-wlegend{display:flex;gap:14px;margin-top:10px;font-size:11px;color:var(--pp-txt3);}
.pp-wlegend i{display:inline-block;width:9px;height:9px;border-radius:3px;margin-right:4px;vertical-align:-1px;}
.pp-whist{background:var(--pp-card);border:.5px solid var(--pp-sep2);border-radius:18px;overflow:hidden;}
.pp-whist-day{padding:9px 14px 4px;font-size:11px;font-weight:700;color:var(--pp-txt3);text-transform:uppercase;
 letter-spacing:.5px;background:var(--pp-fill3);}
.pp-wrow{display:flex;align-items:center;gap:12px;padding:11px 14px;border-bottom:.5px solid var(--pp-sep2);}
.pp-wrow:last-child{border-bottom:none;}
.pp-wic{width:36px;height:36px;border-radius:50%;display:flex;align-items:center;justify-content:center;flex-shrink:0;}
.pp-wic svg{width:17px;height:17px;}
.pp-wic.in{background:rgba(48,209,88,.2);color:#30d158;}
.pp-wic.out{background:rgba(255,69,58,.16);color:#ff453a;}
.pp-wrow-meta{flex:1;min-width:0;}
.pp-wrow-name{font-size:15px;font-weight:600;color:var(--pp-txt);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.pp-wrow-sub{font-size:12px;color:var(--pp-txt3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.pp-wamt{font-size:16px;font-weight:700;flex-shrink:0;font-variant-numeric:tabular-nums;}
.pp-wamt.in{color:#30d158;}
.pp-wamt.out{color:var(--pp-txt);}
.pp-wbot{display:flex;align-items:center;gap:12px;padding:11px 14px;border-bottom:.5px solid var(--pp-sep2);}
.pp-wbot:last-child{border-bottom:none;}
.pp-wbot-bal{font-size:15px;font-weight:700;font-variant-numeric:tabular-nums;}

/* ══ period ══ */
.pp-period-body{flex:1;overflow-y:auto;overscroll-behavior:contain;padding:14px 16px 26px;}
.pp-ring-wrap{display:flex;flex-direction:column;align-items:center;padding:10px 0 16px;}
.pp-ring{position:relative;width:196px;height:196px;}
.pp-ring svg{width:100%;height:100%;transform:rotate(-90deg);}
.pp-ring-bg{fill:none;stroke:var(--pp-fill3);stroke-width:14;}
.pp-ring-fg{fill:none;stroke:url(#pp-ring-grad);stroke-width:14;stroke-linecap:round;
 transition:stroke-dashoffset .9s var(--pp-ease);}
.pp-ring-mid{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;}
.pp-ring-day{font-size:44px;font-weight:800;letter-spacing:-2px;line-height:1;}
.pp-ring-lb{font-size:13px;color:var(--pp-txt3);font-weight:600;}
.pp-ring-phase{font-size:12px;padding:3px 11px;border-radius:11px;background:var(--pp-fill3);color:var(--pp-txt2);margin-top:5px;}
.pp-pstats{display:flex;gap:9px;margin-bottom:12px;}
.pp-pstat{flex:1;background:var(--pp-card);border:.5px solid var(--pp-sep2);border-radius:16px;padding:12px 10px;text-align:center;}
.pp-pstat b{display:block;font-size:19px;font-weight:700;}
.pp-pstat span{font-size:11px;color:var(--pp-txt3);}
.pp-cal-head{display:flex;align-items:center;justify-content:space-between;margin:6px 0 10px;}
.pp-cal-head b{font-size:16px;font-weight:700;}
.pp-cal-nav{width:34px;height:34px;border-radius:50%;border:none;background:var(--pp-fill3);color:var(--pp-txt);
 cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0;}
.pp-cal-nav svg{width:10px;height:16px;}
.pp-cal-dow{display:grid;grid-template-columns:repeat(7,1fr);gap:4px;margin-bottom:4px;}
.pp-cal-dow span{text-align:center;font-size:11px;color:var(--pp-txt3);padding:4px 0;}
.pp-cal-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:4px;}
.pp-cal-cell{aspect-ratio:1;border:none;border-radius:50%;background:transparent;color:var(--pp-txt);font-size:14px;
 cursor:pointer;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;
 position:relative;font-family:inherit;transition:transform .14s var(--pp-spring);}
.pp-cal-cell:active{transform:scale(.88);}
.pp-cal-cell.empty{visibility:hidden;pointer-events:none;}
.pp-cal-cell.today{box-shadow:inset 0 0 0 1.5px var(--pp-accent);}
.pp-cal-cell.on{background:linear-gradient(155deg,#ff6482,#ff375f);color:#fff;font-weight:700;}
.pp-cal-cell.pred{box-shadow:inset 0 0 0 1.5px rgba(255,100,130,.5);color:rgba(255,140,160,.9);}
.pp-cal-cell.ovu{box-shadow:inset 0 0 0 1.5px rgba(50,173,230,.5);}
.pp-cal-dot{width:4px;height:4px;border-radius:50%;background:var(--pp-txt3);}
.pp-cal-cell.on .pp-cal-dot{background:#fff;}
.pp-cal-legend{display:flex;flex-wrap:wrap;gap:12px;margin-top:12px;font-size:11px;color:var(--pp-txt3);}
.pp-cal-legend i{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:4px;vertical-align:-1px;}
.pp-tags-pick{display:flex;flex-wrap:wrap;gap:7px;}
.pp-tag-btn{background:var(--pp-fill3);border:1.5px solid transparent;color:var(--pp-txt2);font-size:13px;
 padding:7px 13px;border-radius:15px;cursor:pointer;font-family:inherit;transition:all .16s;}
.pp-tag-btn.on{background:rgba(255,55,95,.2);border-color:#ff375f;color:var(--pp-txt);}
.pp-cyclerow{display:flex;align-items:center;gap:12px;padding:11px 14px;border-bottom:.5px solid var(--pp-sep2);}
.pp-cyclerow:last-child{border-bottom:none;}
.pp-cycle-ic{width:34px;height:34px;border-radius:50%;background:rgba(255,55,95,.16);color:#ff6482;
 display:flex;align-items:center;justify-content:center;flex-shrink:0;}
.pp-cycle-ic svg{width:15px;height:15px;}
.pp-promptbox{display:block;width:100%;box-sizing:border-box;min-height:130px;max-height:360px;
 overflow:auto;-webkit-overflow-scrolling:touch;white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word;
 background:var(--pp-fill3);border:.5px solid var(--pp-sep2);border-radius:14px;padding:12px 14px;font-size:12px;line-height:1.6;
 color:var(--pp-txt2);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;}

/* ══ overlays ══ */
.pp-ov{position:absolute;inset:0;z-index:9500;display:flex;background:rgba(0,0,0,.5);
 backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px);box-sizing:border-box;}
.pp-ov.center{align-items:center;justify-content:center;padding:28px;}
.pp-ov.bottom{align-items:flex-end;justify-content:center;}
.pp-dlg{background:var(--pp-sheet);backdrop-filter:blur(34px) saturate(1.7);-webkit-backdrop-filter:blur(34px) saturate(1.7);
 border-radius:20px;max-width:304px;width:100%;padding:20px;box-shadow:0 24px 64px rgba(0,0,0,.5);
 border:.5px solid rgba(255,255,255,.12);animation:pp-dlg-in .26s var(--pp-spring);
 max-height:calc(100% - 12px);display:flex;flex-direction:column;box-sizing:border-box;}
@keyframes pp-dlg-in{from{transform:scale(.92);opacity:0}to{transform:none;opacity:1}}
.pp-dlg-title{font-size:16px;font-weight:700;color:var(--pp-txt);margin-bottom:10px;flex-shrink:0;}
.pp-dlg-body{font-size:13px;line-height:1.6;color:var(--pp-txt2);overflow-y:auto;min-height:0;max-height:60vh;}
.pp-dlg-row{display:flex;gap:8px;margin-top:14px;flex-shrink:0;}
.pp-dlg-row .pp-btn{flex:1;}
.pp-sheet{width:100%;max-width:393px;background:var(--pp-sheet);
 backdrop-filter:blur(34px) saturate(1.7);-webkit-backdrop-filter:blur(34px) saturate(1.7);
 border-radius:22px 22px 0 0;padding-bottom:calc(10px + env(safe-area-inset-bottom));
 box-shadow:0 -14px 44px rgba(0,0,0,.5);animation:pp-sheet-in .3s var(--pp-spring);
 display:flex;flex-direction:column;max-height:76%;}
@keyframes pp-sheet-in{from{transform:translateY(100%)}to{transform:none}}
.pp-sheet-grab{width:38px;height:4px;border-radius:3px;background:var(--pp-fill1);margin:8px auto 4px;flex-shrink:0;}
.pp-sheet-head{padding:8px 18px 12px;display:flex;align-items:center;justify-content:space-between;flex-shrink:0;}
.pp-sheet-title{font-size:16px;font-weight:700;color:var(--pp-txt);}
.pp-sheet-body{flex:1;overflow-y:auto;padding:0 4px;}
.pp-sheet-acts{padding:4px 10px 6px;}
.pp-sheet-act{width:100%;background:none;border:none;border-top:.5px solid var(--pp-sep2);color:var(--pp-txt);
 font-size:16px;padding:14px;cursor:pointer;text-align:left;display:flex;align-items:center;gap:11px;font-family:inherit;
 border-radius:0;}
.pp-sheet-act:first-child{border-top:none;}
.pp-sheet-act:active{background:var(--pp-fill3);}
.pp-sheet-act svg{width:18px;height:18px;color:var(--pp-txt3);flex-shrink:0;}
.pp-sheet-act.danger{color:#ff453a;}
.pp-sheet-act.danger svg{color:#ff453a;}
.pp-sheet-cancel{margin:6px 10px 0;background:var(--pp-fill2);border:none;color:var(--pp-accent);font-size:16px;
 font-weight:600;padding:14px;border-radius:15px;cursor:pointer;width:calc(100% - 20px);font-family:inherit;}
.pp-ms-row{display:flex;align-items:center;gap:12px;width:100%;background:none;border:none;
 border-top:.5px solid var(--pp-sep2);padding:11px 16px;color:var(--pp-txt);cursor:pointer;text-align:left;font-family:inherit;}
.pp-ms-check{width:23px;height:23px;border-radius:50%;border:1.5px solid var(--pp-fill1);display:flex;
 align-items:center;justify-content:center;color:#fff;flex-shrink:0;}
.pp-ms-check.on{background:var(--pp-accent);border-color:var(--pp-accent);}
.pp-ms-check svg{width:14px;height:14px;}
.pp-quote{background:var(--pp-fill2);border-left:3px solid var(--pp-accent);border-radius:0 11px 11px 0;
 padding:8px 12px;margin-bottom:10px;}
.pp-quote-lb{font-size:11px;color:var(--pp-accent);font-weight:600;margin-bottom:2px;}
.pp-quote-txt{font-size:14px;color:var(--pp-txt);line-height:1.42;}

/* toast */
#pp-toast{position:absolute;bottom:88px;left:50%;transform:translateX(-50%) translateY(8px);
 background:var(--pp-glass2);color:var(--pp-txt);padding:10px 18px;border-radius:20px;font-size:14px;opacity:0;
 transition:opacity .22s,transform .28s var(--pp-spring);pointer-events:none;z-index:9900;
 backdrop-filter:blur(26px) saturate(1.6);white-space:nowrap;max-width:82%;overflow:hidden;text-overflow:ellipsis;
 box-shadow:0 8px 28px rgba(0,0,0,.4);border:.5px solid rgba(255,255,255,.12);}
#pp-toast.show{opacity:1;transform:translateX(-50%) translateY(0);}

/* voice overlay */
#pp-voice-ov{position:absolute;inset:0;z-index:400;background:rgba(0,0,0,.58);backdrop-filter:blur(18px);
 display:flex;align-items:center;justify-content:center;padding:40px 32px;opacity:0;transition:opacity .3s;}
#pp-voice-ov.show{opacity:1;}
.pp-voice-ov-inner{font-size:23px;line-height:1.5;color:#fff;text-align:center;text-shadow:0 2px 16px rgba(0,0,0,.7);}
.pp-voice-ov-inner span{opacity:0;transform:translateY(8px);transition:opacity .35s,transform .35s;display:inline-block;}
.pp-voice-ov-inner span.show{opacity:1;transform:none;}
.pp-voice-ov-close{position:absolute;top:16px;right:16px;width:34px;height:34px;border-radius:50%;border:none;
 background:rgba(255,255,255,.18);color:#fff;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0;}
.pp-voice-ov-close svg{width:16px;height:16px;}

/* loading */
.pp-loading{display:flex;flex-direction:column;align-items:center;justify-content:center;height:180px;gap:10px;
 color:var(--pp-txt3);}
.pp-spinner{width:34px;height:34px;border-radius:50%;border:3px solid var(--pp-fill2);border-top-color:var(--pp-accent);
 animation:pp-spin .9s linear infinite;}
.pp-loading-txt{font-size:14px;}

@media (max-width:440px){
 #pp-frame{width:100vw;height:100dvh;border-radius:0;box-shadow:none;}
 .pp-home-clock{font-size:66px;}
 .pp-grid{gap:20px 10px;padding:16px 18px 6px;}
 .pp-icon{width:54px;height:54px;}
 .pp-icon svg{width:27px;height:27px;}
}
@media (prefers-reduced-motion:reduce){
 #pp-island,#pp-ext-island,.pp-island-av,.pp-island-body,.pp-bubble,.pp-app,.pp-gen,.pp-call-line,
 .pp-screen.pp-enter,.pp-dlg,.pp-sheet,.pp-story-ring.unseen,.pp-sv-bar i,.pp-fly-heart,.pp-spinner,
 .pp-swipe-inner,.pp-ring-fg{transition:none!important;animation:none!important;}
 .pp-sv-bar i.active{width:100%!important;}
}
.pp-sec-label svg{width:15px;height:15px;flex-shrink:0;}
.pp-cmt-to svg{width:11px;height:11px;vertical-align:-1px;}
/* ══ 1.4.4 : voice text + slower overlay ══ */
.pp-voice-text{font-size:13px;line-height:1.5;padding:7px 4px 1px;opacity:.9;word-break:break-word;
 border-top:.5px solid rgba(255,255,255,.16);margin-top:7px;}
.pp-brow.in .pp-voice-text{border-top-color:var(--pp-sep);}
.pp-voice-ov-box{display:flex;flex-direction:column;align-items:center;gap:20px;max-width:100%;}
.pp-voice-ov-full{font-size:14px;line-height:1.65;color:rgba(255,255,255,.62);text-align:center;
 max-width:88%;text-shadow:0 1px 6px rgba(0,0,0,.7);border-top:1px solid rgba(255,255,255,.16);padding-top:16px;}
#pp-voice-ov.paused .pp-voice-ov-box::after{content:'หยุดไว้ · แตะเพื่อเล่นต่อ';font-size:12px;
 color:rgba(255,255,255,.55);letter-spacing:.4px;}
#pp-voice-ov:not(.paused) .pp-voice-ov-box::after{content:'แตะเพื่อหยุดอ่าน';font-size:11px;
 color:rgba(255,255,255,.3);letter-spacing:.4px;}
/* ══ 1.4.1 : compact picker rows ══ */
.pp-ms-row.pp-ms-compact{padding:8px 16px;gap:10px;}
.pp-ms-row.pp-ms-compact svg{width:13px;height:13px;opacity:.5;flex-shrink:0;}
/* ══ 1.4.0 : profile tab icons + wallet action ══ */
.pp-proftabs button{display:flex;align-items:center;justify-content:center;gap:5px;padding:10px 0 8px;}
.pp-proftabs svg{width:15px;height:15px;flex-shrink:0;}
.pp-proftabs span{font-size:12px;}
.pp-wact svg{width:19px;height:19px;}
.pp-wact{padding:11px 5px;font-size:11px;gap:5px;}
/* ══ 1.4.0 : unsend bubble + system line ══ */
.pp-bubble-unsent{display:flex;align-items:center;gap:7px;}
.pp-bubble-unsent svg{width:13px;height:13px;flex-shrink:0;opacity:.7;}
.pp-bubble-unsent.peekable{cursor:pointer;}
.pp-peek-hint{font-size:10px;opacity:.55;font-style:normal;margin-left:2px;}
.pp-sysline{align-self:center;max-width:82%;text-align:center;font-size:12px;line-height:1.55;
 color:var(--pp-txt3);background:var(--pp-fill3);border-radius:13px;padding:7px 14px;margin:12px auto 4px;}
.pp-sysline svg{width:12px;height:12px;vertical-align:-2px;margin-right:4px;opacity:.7;}
/* ══ 1.3.0 : call bar + call history ══ */
.pp-call-bar{position:relative;z-index:2;display:flex;align-items:center;justify-content:space-between;
 padding:6px 12px 0;gap:8px;}
.pp-call-barbtn{display:flex;align-items:center;gap:6px;background:rgba(255,255,255,.14);border:none;color:#fff;
 border-radius:16px;padding:7px 13px;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit;
 backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);transition:background .16s,transform .14s var(--pp-spring);}
.pp-call-barbtn:active{transform:scale(.94);}
.pp-call-barbtn.on{background:#fff;color:#000;}
.pp-call-barbtn svg{width:13px;height:13px;}
#pp-scr-call.ringing .pp-call-bar{display:none;}
.pp-call-stage.pp-call-hist-mode{justify-content:flex-start;overflow-y:auto;overscroll-behavior:contain;
 -webkit-overflow-scrolling:touch;align-items:stretch;gap:10px;padding:16px 22px;text-align:left;}
.pp-call-stage.pp-call-hist-mode .pp-call-line{font-size:16px;line-height:1.5;opacity:1;transform:none;
 background:rgba(255,255,255,.1);border-radius:16px;padding:9px 14px;max-width:86%;align-self:flex-start;
 backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);}
.pp-call-stage.pp-call-hist-mode .pp-call-line.me{align-self:flex-end;background:rgba(255,255,255,.2);
 color:#fff;font-size:15px;}
.pp-bubble-unsent{opacity:.7;font-style:italic;background:var(--pp-fill3)!important;color:var(--pp-txt3)!important;box-shadow:none!important;cursor:pointer;}

/* ══ 1.0.0 : repost / mention / clout / news ══ */
.pp-repost-tag{display:flex;align-items:center;gap:6px;padding:0 16px 4px;font-size:12px;color:var(--pp-txt3);font-weight:600;}
.pp-repost-tag svg{width:13px;height:13px;}
.pp-quote-card{margin:0 16px 9px;border:.5px solid var(--pp-sep);border-radius:15px;overflow:hidden;background:var(--pp-fill3);cursor:pointer;}
.pp-quote-card-head{display:flex;align-items:center;gap:8px;padding:9px 11px 4px;}
.pp-quote-card-name{font-size:12px;font-weight:700;color:var(--pp-txt);}
.pp-quote-card-age{font-size:11px;color:var(--pp-txt3);}
.pp-quote-card-text{font-size:13px;line-height:1.45;padding:0 11px 9px;color:var(--pp-txt2);}
.pp-quote-card-img{width:100%;height:150px;background:var(--pp-sep) center/cover no-repeat;}
.pp-quote-card-gone{padding:14px;text-align:center;font-size:12px;color:var(--pp-txt3);}
.pp-post-actions .rp{color:var(--pp-txt2);}
.pp-post-actions .rp.on{color:#30d158;}
.pp-mention{color:var(--pp-accent);cursor:pointer;font-weight:600;}
.pp-heat{display:inline-flex;align-items:center;gap:3px;font-size:11px;padding:2px 8px;border-radius:10px;margin-left:6px;vertical-align:1px;}
.pp-heat svg{width:11px;height:11px;}
.pp-heat.h1{background:rgba(255,159,10,.18);color:#ff9f0a;}
.pp-heat.h2{background:rgba(255,100,130,.2);color:#ff6482;}
.pp-heat.h3{background:rgba(255,69,58,.24);color:#ff453a;}
.pp-tone{font-size:11px;padding:2px 8px;border-radius:10px;margin-left:6px;}
.pp-tone.good{background:rgba(48,209,88,.18);color:#30d158;}
.pp-tone.bad{background:rgba(255,69,58,.2);color:#ff453a;}
.pp-tone.mid{background:var(--pp-fill2);color:var(--pp-txt3);}
.pp-clout-card{margin:10px 16px;border-radius:18px;padding:14px 16px;color:#fff;overflow:hidden;position:relative;
 background:linear-gradient(150deg,rgba(191,90,242,.9),rgba(255,55,95,.78));box-shadow:0 10px 30px rgba(0,0,0,.34);}
.pp-clout-top{display:flex;align-items:center;gap:7px;font-size:12px;font-weight:700;opacity:.9;letter-spacing:.4px;}
.pp-clout-top svg{width:14px;height:14px;}
.pp-clout-main{font-size:29px;font-weight:800;letter-spacing:-.8px;margin:8px 0 2px;}
.pp-clout-sub{font-size:12px;opacity:.9;display:flex;align-items:center;gap:5px;}
.pp-clout-sub svg{width:12px;height:12px;}
.pp-newsrow{display:flex;gap:12px;padding:12px 16px;border-bottom:.5px solid var(--pp-sep);cursor:pointer;}
.pp-newsrow:active{background:var(--pp-fill3);}
.pp-newsrow-meta{flex:1;min-width:0;}
.pp-newsrow-src{font-size:11px;font-weight:700;color:var(--pp-accent);text-transform:uppercase;letter-spacing:.4px;}
.pp-newsrow-title{font-size:15px;font-weight:600;line-height:1.4;color:var(--pp-txt);margin:2px 0 3px;
 display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;}
.pp-newsrow-foot{font-size:11px;color:var(--pp-txt3);display:flex;gap:10px;}
.pp-newsrow-thumb{width:78px;height:78px;border-radius:12px;flex-shrink:0;background:var(--pp-fill3) center/cover no-repeat;
 display:flex;align-items:center;justify-content:center;color:var(--pp-txt3);}
.pp-newsrow-thumb svg{width:24px;height:24px;opacity:.5;}
.pp-newsrow.unseen .pp-newsrow-title::after{content:'';display:inline-block;width:6px;height:6px;border-radius:50%;
 background:var(--pp-accent);margin-left:6px;vertical-align:2px;}
.pp-ghost-badge{font-size:10px;padding:1px 6px;border-radius:8px;background:var(--pp-fill2);color:var(--pp-txt3);margin-left:4px;}
/* ══ 1.3.0 : token card + chip ══ */
.pp-tokcard{position:relative;border-radius:20px;padding:16px 18px;color:#fff;overflow:hidden;margin-bottom:8px;
 background:linear-gradient(150deg,rgba(48,209,88,.85),rgba(10,132,255,.72));
 box-shadow:0 12px 32px rgba(0,0,0,.34),inset 0 1px 0 rgba(255,255,255,.22);}
.pp-tokcard-top{display:flex;align-items:baseline;justify-content:space-between;gap:10px;}
.pp-tokcard-lb{font-size:12px;font-weight:700;opacity:.9;letter-spacing:.5px;text-transform:uppercase;}
.pp-tokcard-num{font-size:27px;font-weight:800;letter-spacing:-.6px;}
.pp-tokcard-sub{font-size:11px;opacity:.85;margin-top:5px;line-height:1.5;}
.pp-tokcard-acts{display:flex;gap:6px;flex-wrap:wrap;margin-top:12px;}
.pp-tokcard-acts .pp-btn{background:rgba(255,255,255,.2);color:#fff;padding:7px 12px;font-size:12px;}
.pp-tokcard-acts .pp-btn.primary{background:#fff;color:#0a84ff;}
.pp-tokchip{font-size:11px;font-weight:700;padding:3px 9px;border-radius:10px;background:var(--pp-fill3);
 color:var(--pp-txt3);font-variant-numeric:tabular-nums;white-space:nowrap;}
.pp-tokchip.on{background:rgba(255,159,10,.2);color:#ff9f0a;}
.pp-searchpick{padding:8px 16px 4px;flex-shrink:0;position:relative;}
.pp-searchpick input{width:100%;box-sizing:border-box;padding:9px 14px 9px 34px;border-radius:11px;border:none;
 background:var(--pp-fill3);color:var(--pp-txt);font-size:15px;font-family:inherit;}
.pp-searchpick input:focus{outline:none;background:var(--pp-fill2);}
.pp-searchpick .ic{position:absolute;left:27px;top:17px;pointer-events:none;color:var(--pp-txt3);}
.pp-searchpick .ic svg{width:15px;height:15px;}
`;
 document.head.appendChild(s);
}

// ══════════════════════════════════════════════════════════
// buildPhone — โครง HTML ทุกหน้าจอ
// ══════════════════════════════════════════════════════════
function buildPhone() {
 const grid = APPS.map(a =>
 `<button class="pp-app" data-nav="${a.nav}">
 <span class="pp-icon" style="color:${a.glow}">${a.icon}<span class="pp-icon-badge" data-badge="${a.nav}"></span></span>
 <span class="pp-label">${a.label}</span>
 </button>`).join('');

 return `
<dialog id="pp-dialog">
 <div id="pp-frame" class="dark">
 <div id="pp-statusbar">
 <span class="pp-sb-left pp-clock">9:41</span>
 <div id="pp-island"></div>
 <span class="pp-sb-right">${ICON.signal}${ICON.wifi}${ICON.battery}
 <button id="pp-close-btn" title="ปิด">${ICON.close}</button></span>
 </div>

 <div id="pp-screens">

 <!-- ══ HOME ══ -->
 <div class="pp-screen show" id="pp-home">
 <div id="pp-home-wp"></div>
 <div class="pp-home-clock pp-clock">9:41</div>
 <div id="pp-home-date">—</div>
 <div class="pp-home-widgets">
 <div class="pp-widget" data-nav="period">
 <div class="pp-widget-head">${ICON.drop} รอบเดือน</div>
 <div class="pp-widget-main" id="pp-w-period">—</div>
 <div class="pp-widget-sub" id="pp-w-period-sub"></div>
 </div>
 <div class="pp-widget" data-nav="wallet">
 <div class="pp-widget-head">${ICON.wallet} ยอดเงิน</div>
 <div class="pp-widget-main" id="pp-w-wallet">—</div>
 <div class="pp-widget-sub" id="pp-w-wallet-sub"></div>
 </div>
 </div>
 <div class="pp-grid">${grid}</div>
 <div class="pp-home-bar"></div>
 </div>

 <!-- ══ MESSAGES ══ -->
 <div class="pp-screen" id="pp-scr-messages">
 <div class="pp-nav">
 <button class="pp-nav-back" data-nav="home">${ICON.back}</button>
 <span class="pp-nav-title">ข้อความ</span>
 <div class="pp-nav-tools">
 <button class="pp-nav-action" id="pp-group-new-btn" title="สร้างกลุ่ม">${ICON.users}</button>
 <button class="pp-nav-action" id="pp-msg-menu-btn" title="เมนู">${ICON.menu}</button>
 <button class="pp-nav-action" data-nav="contacts" title="เพิ่มคนคุย">${ICON.compose}</button>
 </div>
 </div>
 <div class="pp-search-wrap">
 <span class="pp-search-ico">${ICON.search}</span>
 <input class="pp-search" id="pp-msg-search" placeholder="ค้นหาชื่อหรือข้อความ">
 </div>
 <div class="pp-notes-row" id="pp-notes-row"></div>
 <div class="pp-tabs" id="pp-chat-tabs">
 <button data-chattab="unread">ยังไม่อ่าน</button>
 <button data-chattab="pin">ปักหมุด</button>
 <button data-chattab="char" class="on">ตัวละคร</button>
 <button data-chattab="npc">NPC</button>
 </div>
 <div class="pp-list" id="pp-contact-list"></div>
 <div class="pp-home-bar"></div>
 </div>

 <!-- ══ ADD CONTACTS ══ -->
 <div class="pp-screen" id="pp-scr-contacts">
 <div class="pp-nav">
 <button class="pp-nav-back" data-nav="messages">${ICON.back}</button>
 <span class="pp-nav-title">เพิ่มคนคุย</span>
 <div class="pp-nav-tools"></div>
 </div>
 <div class="pp-list" id="pp-add-list"></div>
 <input type="file" id="pp-npc-av-file" accept="image/*" hidden>
 <div class="pp-home-bar"></div>
 </div>

 <!-- ══ ARCHIVE ══ -->
 <div class="pp-screen" id="pp-scr-archive">
 <div class="pp-nav">
 <button class="pp-nav-back" data-nav="messages">${ICON.back}</button>
 <span class="pp-nav-title">คลังเก็บ</span>
 <div class="pp-nav-tools"></div>
 </div>
 <div class="pp-list" id="pp-archive-list"></div>
 <div class="pp-home-bar"></div>
 </div>

 <!-- ══ GROUP EDITOR ══ -->
 <div class="pp-screen" id="pp-scr-groupnew">
 <div class="pp-nav">
 <button class="pp-nav-back" data-nav="messages">${ICON.back}</button>
 <span class="pp-nav-title" id="pp-groupnew-title">สร้างกลุ่ม</span>
 <div class="pp-nav-tools">
 <button class="pp-nav-action pp-nav-txtbtn" id="pp-group-save-btn">สร้าง</button>
 </div>
 </div>
 <div class="pp-body" id="pp-groupnew-body"></div>
 <div class="pp-home-bar"></div>
 </div>

 <!-- ══ GROUP SETTINGS ══ -->
 <div class="pp-screen" id="pp-scr-groupsettings">
 <div class="pp-nav">
 <button class="pp-nav-back" data-nav="chat">${ICON.back}</button>
 <span class="pp-nav-title">ตั้งค่ากลุ่ม</span>
 <div class="pp-nav-tools">
 <button class="pp-nav-action" id="pp-group-del-btn" title="ลบกลุ่ม">${ICON.trash}</button>
 </div>
 </div>
 <div class="pp-body" id="pp-groupsettings-body"></div>
 <div class="pp-home-bar"></div>
 </div>

 <!-- ══ CHAT ══ -->
 <div class="pp-screen" id="pp-scr-chat" data-tail="round">
 <div class="pp-chat-header">
 <button class="pp-nav-back" data-nav="messages">${ICON.back}</button>
 <div class="pp-chat-hdr-center" id="pp-chat-hdr-center">
 <span id="pp-chat-hdr-av"></span>
 <span class="pp-chat-hdr-name" id="pp-chat-hdr-name">—</span>
 </div>
 <div class="pp-nav-tools">
 <button class="pp-nav-action" id="pp-chat-call-btn" title="โทร">${ICON.phoneApp}</button>
 <button class="pp-nav-action" id="pp-chat-menu-btn" title="เมนู">${ICON.menu}</button>
 </div>
 </div>
 <div class="pp-star-banner" id="pp-star-banner" style="display:none">
 ${ICON.star}<span id="pp-star-banner-txt"></span>
 </div>
 <div class="pp-search-wrap" id="pp-chat-search-wrap" style="display:none">
 <span class="pp-search-ico">${ICON.search}</span>
 <input class="pp-search" id="pp-chat-search" placeholder="ค้นหาในห้องนี้">
 </div>
 <div class="pp-msgs" id="pp-msgs"></div>
 <div class="pp-sticker-tray" id="pp-sticker-tray">
 <div class="pp-sticker-packs" id="pp-sticker-packs"></div>
 <div class="pp-sticker-grid" id="pp-sticker-grid"></div>
 </div>
 <div class="pp-inputbar">
 <button class="pp-round-btn" id="pp-attach-btn" title="แนบ">${ICON.plus}</button>
 <button class="pp-round-btn" id="pp-sticker-btn" title="สติกเกอร์">${ICON.sticker}</button>
 <textarea class="pp-input" id="pp-input" rows="1" placeholder="ข้อความ"></textarea>
 <button class="pp-gen" id="pp-gen" title="ให้บอทตอบ">${ICON.generate}</button>
 <button class="pp-gen pp-stop" id="pp-stop" title="หยุด" style="display:none">${ICON.stop}</button>
 </div>
 <input type="file" id="pp-chat-img-file" accept="image/*" hidden>
 <div class="pp-home-bar"></div>
 </div>

 <!-- ══ STARRED ══ -->
 <div class="pp-screen" id="pp-scr-starred">
 <div class="pp-nav">
 <button class="pp-nav-back" data-nav="chat">${ICON.back}</button>
 <span class="pp-nav-title">ข้อความติดดาว</span>
 <div class="pp-nav-tools"></div>
 </div>
 <div class="pp-msgs" id="pp-starred-body"></div>
 <div class="pp-home-bar"></div>
 </div>

 <!-- ══ CHAT SETTINGS ══ -->
 <div class="pp-screen" id="pp-scr-chatsettings">
 <div class="pp-nav">
 <button class="pp-nav-back" data-nav="chat">${ICON.back}</button>
 <span class="pp-nav-title">ตั้งค่าแชท</span>
 <div class="pp-nav-tools"></div>
 </div>
 <div class="pp-body" id="pp-chatsettings-body"></div>
 <div class="pp-home-bar"></div>
 </div>

 <!-- ══ FEED (4 แท็บ) ══ -->
 <div class="pp-screen" id="pp-scr-feed">
 <div class="pp-nav">
 <button class="pp-nav-back" data-nav="home">${ICON.back}</button>
 <span class="pp-nav-title" id="pp-feed-title">ฟีด</span>
 <div class="pp-nav-tools" id="pp-feed-tools"></div>
 </div>
 <div class="pp-feed-scroll" id="pp-feed-scroll"></div>
 <button class="pp-fab-inpage" id="pp-feed-add" title="สร้าง">${ICON.plus}</button>
 <div class="pp-tabbar" id="pp-feed-tabbar">
 <button data-feedtab="home" class="on">${ICON.messages}<span>หน้าแรก</span></button>
 <button data-feedtab="explore">${ICON.compass}<span>สำรวจ</span></button>
 <button data-feedtab="news">${ICON.news}<span>ข่าว</span></button>
 <button data-feedtab="activity">${ICON.heartOut}<span>กิจกรรม</span><span class="pp-tb-badge" id="pp-act-badge" style="display:none"></span></button>
 <button data-feedtab="profile">${ICON.person}<span>โปรไฟล์</span></button>
 </div>
 <input type="file" id="pp-story-img-file" accept="image/*" hidden>
 <input type="file" id="pp-newpost-img-file" accept="image/*" multiple hidden>
 </div>

 <!-- ══ NEWS READER (1.0.0) ══ -->
 <div class="pp-screen" id="pp-scr-newsapp">
 <div class="pp-nav">
 <button class="pp-nav-back" data-nav="home">${ICON.back}</button>
 <span class="pp-nav-title">ข่าว</span>
 <div class="pp-nav-tools">
 <button class="pp-nav-action" id="pp-news-gen" title="โหลดข่าวใหม่">${ICON.generate}</button>
 <button class="pp-nav-action pp-stop" id="pp-news-stop" title="หยุด" style="display:none">${ICON.stop}</button>
 </div>
 </div>
 <div class="pp-list" id="pp-newsapp-list"></div>
 <div class="pp-home-bar"></div>
 </div>

 <!-- ══ NEW POST ══ -->
 <div class="pp-screen" id="pp-scr-newpost">
 <div class="pp-nav">
 <button class="pp-nav-back" data-nav="feed">${ICON.back}</button>
 <span class="pp-nav-title" id="pp-newpost-title">สร้างโพสต์</span>
 <div class="pp-nav-tools">
 <button class="pp-nav-action pp-nav-txtbtn" id="pp-newpost-save">โพสต์</button>
 </div>
 </div>
 <div class="pp-body" id="pp-newpost-body"></div>
 <div class="pp-home-bar"></div>
 </div>

 <!-- ══ POST VIEW ══ -->
 <div class="pp-screen" id="pp-scr-postview">
 <div class="pp-nav">
 <button class="pp-nav-back" data-nav="feed">${ICON.back}</button>
 <span class="pp-nav-title">โพสต์</span>
 <div class="pp-nav-tools">
 <button class="pp-nav-action" id="pp-post-gen-btn" title="ให้บอทคอมเมนต์">${ICON.generate}</button>
 <button class="pp-nav-action pp-stop" id="pp-post-stop-btn" title="หยุด" style="display:none">${ICON.stop}</button>
 </div>
 </div>
 <div class="pp-feed-scroll" id="pp-post-body"></div>
 <div class="pp-inputbar">
 <textarea class="pp-input" id="pp-comment-input" rows="1" placeholder="เขียนคอมเมนต์"></textarea>
 <button class="pp-gen" id="pp-comment-send" title="ส่ง">${ICON.send}</button>
 </div>
 <div class="pp-home-bar"></div>
 </div>

 <!-- ══ PROFILE EDIT ══ -->
 <div class="pp-screen" id="pp-scr-profedit">
 <div class="pp-nav">
 <button class="pp-nav-back" data-nav="feed">${ICON.back}</button>
 <span class="pp-nav-title">แก้ไขโปรไฟล์</span>
 <div class="pp-nav-tools">
 <button class="pp-nav-action pp-nav-txtbtn" id="pp-prof-save">บันทึก</button>
 </div>
 </div>
 <div class="pp-body" id="pp-profedit-body"></div>
 <input type="file" id="pp-prof-av-file" accept="image/*" hidden>
 <div class="pp-home-bar"></div>
 </div>

 <!-- ══ ACCOUNT SETTINGS ══ -->
 <div class="pp-screen" id="pp-scr-account">
 <div class="pp-nav">
 <button class="pp-nav-back" data-nav="feed">${ICON.back}</button>
 <span class="pp-nav-title">ความเป็นส่วนตัว</span>
 <div class="pp-nav-tools"></div>
 </div>
 <div class="pp-body" id="pp-account-body"></div>
 <div class="pp-home-bar"></div>
 </div>

 <!-- ══ WALLET ══ -->
 <div class="pp-screen" id="pp-scr-wallet">
 <div class="pp-nav">
 <button class="pp-nav-back" data-nav="home">${ICON.back}</button>
 <span class="pp-nav-title">กระเป๋าเงิน</span>
 <div class="pp-nav-tools">
 <button class="pp-nav-action" id="pp-wallet-menu" title="เมนู">${ICON.menu}</button>
 </div>
 </div>
 <div class="pp-seg" id="pp-wallet-seg">
 <button data-wtab="overview" class="on">ภาพรวม</button>
 <button data-wtab="transfer">โอน</button>
 <button data-wtab="history">ประวัติ</button>
 <button data-wtab="settings">ตั้งค่า</button>
 </div>
 <div class="pp-wallet-body" id="pp-wallet-body"></div>
 <div class="pp-home-bar"></div>
 </div>

 <!-- ══ PERIOD ══ -->
 <div class="pp-screen" id="pp-scr-period">
 <div class="pp-nav">
 <button class="pp-nav-back" data-nav="home">${ICON.back}</button>
 <span class="pp-nav-title">ประจำเดือน</span>
 <div class="pp-nav-tools">
 <button class="pp-nav-action" id="pp-period-help" title="ช่วยเหลือ">${ICON.eye}</button>
 </div>
 </div>
 <div class="pp-seg" id="pp-period-seg">
 <button data-ptab="today" class="on">วันนี้</button>
 <button data-ptab="calendar">ปฏิทิน</button>
 <button data-ptab="history">ประวัติรอบ</button>
 <button data-ptab="privacy">ความเป็นส่วนตัว</button>
 </div>
 <div class="pp-period-body" id="pp-period-body"></div>
 <div class="pp-home-bar"></div>
 </div>

 <!-- ══ SETTINGS ══ -->
 <div class="pp-screen" id="pp-scr-settings">
 <div class="pp-nav">
 <button class="pp-nav-back" data-nav="home">${ICON.back}</button>
 <span class="pp-nav-title">ตั้งค่า</span>
 <div class="pp-nav-tools"></div>
 </div>
 <div class="pp-body" id="pp-settings-body"></div>
 <input type="file" id="pp-set-wp-file" accept="image/*" hidden>
 <input type="file" id="pp-user-av-file" accept="image/*" hidden>
 <div class="pp-home-bar"></div>
 </div>

 <!-- ══ STICKER MANAGER ══ -->
 <div class="pp-screen" id="pp-scr-stickers">
 <div class="pp-nav">
 <button class="pp-nav-back" data-nav="settings">${ICON.back}</button>
 <span class="pp-nav-title">สติกเกอร์</span>
 <div class="pp-nav-tools">
 <button class="pp-nav-action" id="pp-sticker-import" title="นําเข้า JSON">${ICON.upload}</button>
 <button class="pp-nav-action" id="pp-sticker-add-pack" title="เพิ่มชุด">${ICON.plus}</button>
 </div>
 </div>
 <div class="pp-body" id="pp-stickers-body"></div>
 <input type="file" id="pp-sticker-import-file" accept="application/json,.json" hidden>
 <input type="file" id="pp-sticker-img-file" accept="image/*" multiple hidden>
 <div class="pp-home-bar"></div>
 </div>

 <!-- ══ ACTION LOG VIEWER ══ -->
 <div class="pp-screen" id="pp-scr-logview">
 <div class="pp-nav">
 <button class="pp-nav-back" data-nav="settings">${ICON.back}</button>
 <span class="pp-nav-title">บันทึกกิจกรรม</span>
 <div class="pp-nav-tools">
 <button class="pp-nav-action" id="pp-log-clear" title="ล้างคิว">${ICON.trash}</button>
 </div>
 </div>
 <div class="pp-body" id="pp-logview-body"></div>
 <div class="pp-home-bar"></div>
 </div>

 <!-- ══ SYNC VIEW (1.3.0) ══ -->
 <div class="pp-screen" id="pp-scr-syncview">
 <div class="pp-nav">
 <button class="pp-nav-back" data-nav="settings">${ICON.back}</button>
 <span class="pp-nav-title">ผลซิงค์ล่าสุด</span>
 <div class="pp-nav-tools"></div>
 </div>
 <div class="pp-body" id="pp-syncview-body"></div>
 <div class="pp-home-bar"></div>
 </div>

 <!-- ══ HELPER ══ -->
 <div class="pp-screen" id="pp-scr-helper">
 <div class="pp-nav">
 <button class="pp-nav-back" data-nav="home">${ICON.back}</button>
 <span class="pp-nav-title">ผู้ช่วย</span>
 <div class="pp-nav-tools"></div>
 </div>
 <div class="pp-body" id="pp-helper-body"></div>
 <div class="pp-home-bar"></div>
 </div>

 <!-- ══ CALL ══ -->
 <div class="pp-screen" id="pp-scr-call">
 <div class="pp-call-bg" id="pp-call-bg"></div>
 <div class="pp-call-bar">
 <button class="pp-call-barbtn" id="pp-call-min" title="ย่อสาย ไปเล่นแอปอื่น">${ICON.back}<span>ย่อสาย</span></button>
 <button class="pp-call-barbtn" id="pp-call-hist" title="ดูประวัติสาย">${ICON.clock}<span>ประวัติ</span></button>
 </div>
 <div class="pp-call-top">
 <div class="pp-call-sub" id="pp-call-sub">Pocket Phone</div>
 <div class="pp-call-name" id="pp-call-name"></div>
 <div class="pp-call-status" id="pp-call-status">กำลังโทร…</div>
 <div class="pp-call-dur" id="pp-call-dur" style="display:none">0:00</div>
 <div id="pp-call-av"></div>
 </div>
 <div class="pp-call-stage" id="pp-call-stage"></div>
 <div class="pp-call-typing" id="pp-call-typing"><span></span><span></span><span></span></div>
 <div class="pp-call-inputbar">
 <textarea class="pp-call-input" id="pp-call-input" rows="1" placeholder="พูดว่า…"></textarea>
 <button class="pp-gen" id="pp-call-gen" title="ให้อีกฝ่ายตอบ">${ICON.generate}</button>
 </div>
 <div class="pp-call-ctrls">
 <div class="pp-call-active-ctrls">
 <button class="pp-cc" id="pp-call-mute"><span class="pp-cc-ic">${ICON.mic}</span><span class="pp-cc-lb">ปิดไมค์</span></button>
 <button class="pp-call-end" id="pp-call-end" title="วางสาย">${ICON.hangup}</button>
 <button class="pp-cc" id="pp-call-speaker"><span class="pp-cc-ic">${ICON.speaker}</span><span class="pp-cc-lb">ลำโพง</span></button>
 </div>
 <div class="pp-call-answer">
 <button class="pp-ans-btn decline" id="pp-call-decline"><span class="pp-ans-ic">${ICON.hangup}</span><span>ปฏิเสธ</span></button>
 <button class="pp-ans-btn accept" id="pp-call-accept"><span class="pp-ans-ic">${ICON.phoneApp}</span><span>รับสาย</span></button>
 </div>
 </div>
 <audio id="pp-ringtone-audio" loop preload="none"></audio>
 </div>

 <!-- ══ CALL END ══ -->
 <div class="pp-screen" id="pp-scr-callend">
 <div class="pp-call-bg" id="pp-callend-bg"></div>
 <div class="pp-call-top" style="flex:1;justify-content:center">
 <div id="pp-callend-av"></div>
 <div class="pp-call-name" id="pp-callend-name"></div>
 <div class="pp-call-status" id="pp-callend-sub">สายสิ้นสุด</div>
 <div class="pp-call-dur" id="pp-callend-dur"></div>
 </div>
 <div class="pp-call-ctrls">
 <div class="pp-call-active-ctrls">
 <button class="pp-btn primary" id="pp-callend-ok">เสร็จสิ้น</button>
 </div>
 </div>
 </div>

 <!-- ══ CALL LOG ══ -->
 <div class="pp-screen" id="pp-scr-calllog">
 <div class="pp-nav">
 <button class="pp-nav-back" id="pp-calllog-back">${ICON.back}</button>
 <span class="pp-nav-title" id="pp-calllog-title">โทรศัพท์</span>
 <div class="pp-nav-tools">
 <button class="pp-nav-action" id="pp-calllog-edit-btn" title="แก้ไข">${ICON.trash}</button>
 </div>
 </div>
 <div class="pp-list" id="pp-calllog-list"></div>
 <div class="pp-home-bar"></div>
 </div>

 <!-- ══ TRANSCRIPT ══ -->
 <div class="pp-screen" id="pp-scr-transcript">
 <div class="pp-nav">
 <button class="pp-nav-back" data-nav="calllog">${ICON.back}</button>
 <span class="pp-nav-title" id="pp-transcript-title">บันทึกสาย</span>
 <div class="pp-nav-tools"></div>
 </div>
 <div class="pp-transcript-body" id="pp-transcript-body"></div>
 <div class="pp-home-bar"></div>
 </div>

 </div>

 <div id="pp-story-viewer"></div>
 <div id="pp-toast"></div>
 </div>
</dialog>`;
}

window.PP_LOADED = 'parsed-2of4';
console.log(`[pocket-phone] ${PP_VERSION} ท่อน 2/4 พร้อม - ICON + iGlassOS CSS + โครง HTML`);

// pocket-phone/index.js — 0.9.9 — ท่อน 3/4 (UI helper → แชท → โทร)
// ต่อจากท่อน 2/4 ที่จบตรง window.PP_LOADED = 'parsed-2of4'
// ★ ทุกการกระทำเรียก ppLog() · ไม่มีอิโมจิ · ไม่มีกดค้าง · ติดดาวแทนปักหมุด
// ⚠️ รันเดี่ยวไม่ได้ ต้องแปะครบ 4 ท่อน

// ══════════════════════════════════════════════════════════
// state
// ══════════════════════════════════════════════════════════
let ppActiveContact = null;
let ppActiveGroup = null;
let ppGeneratingId = null;
let ppGenAbort = false;
let ppCurrentScreen = 'home';
let ppCallLogEdit = false;
let ppCallLogFilter = null;
let ppStoryView = null;
let ppStoryTimer = null;
let ppStoryPaused = false;
let ppFeedTab = 'home';
let ppFeedGenBusy = false;
let ppFeedGenAbort = false;
let ppActivePost = null;
let ppCalMonth = new Date();
let ppPeriodDay = null;
let ppPeriodTab = 'today';
let ppWalletTab = 'overview';
let ppHistShown = HIST_PAGE;
let ppChatTab = 'char';
let ppGroupDraft = null;
let ppNewPostDraft = null;
let ppMsgFilter = '';
let ppChatFilter = '';
let ppSelectMode = false;
let ppSelected = new Set();
let ppLogSelected = new Set();
let ppStickerPackActive = null;
let ppUserAvatarCache = null;
let ppClockTimer = null;
let ppIslandState = null;
let ppIslandTimer = null;
let ppCall = null;
let ppGroupCooldownUntil = 0;
let ppExploreTag = null;
let ppProfileTab = 'posts';

// ══════════════════════════════════════════════════════════
// avatar / clock / theme
// ══════════════════════════════════════════════════════════
function userAvatarAuto() {
 const c = ctx();
 try {
 if (c) {
 if (c.userAvatar) return `/User Avatars/${c.userAvatar}`;
 if (c.user_avatar) return `/User Avatars/${c.user_avatar}`;
 const pa = c.powerUserSettings?.persona_description_avatar;
 if (pa) return `/User Avatars/${pa}`;
 }
 } catch {}
 return '';
}
async function refreshUserAvatar() {
 const cfg = getCfg();
 if (cfg.userAvatarMode === 'custom') { const img = await loadMedia('user-avatar'); ppUserAvatarCache = img || userAvatarAuto(); }
 else ppUserAvatarCache = userAvatarAuto();
 return ppUserAvatarCache;
}
function avHTML(src, fallbackChar, size, cls) {
 const s = size || 52;
 const k = cls ? ' ' + cls : '';
 if (src) {
 return `<img class="pp-avatar${k}" style="width:${s}px;height:${s}px" src="${esc(src)}"
 onerror="this.replaceWith(document.createRange().createContextualFragment('<span class=\\'pp-avatar pp-avatar-fb${k}\\' style=\\'width:${s}px;height:${s}px;font-size:${Math.round(s * 0.4)}px\\'>${esc(fallbackChar || '?')}</span>'))">`;
 }
 return `<span class="pp-avatar pp-avatar-fb${k}" style="width:${s}px;height:${s}px;font-size:${Math.round(s * 0.4)}px">${esc(fallbackChar || '?')}</span>`;
}
function userAvatarHTML(size, cls) { return avHTML(ppUserAvatarCache, getUserDisplayName()[0] || 'U', size, cls); }
function contactAvatarHTML(c, size, cls) { return avHTML(c && c.avatar, dname(c)[0], size, cls); }
function groupAvatarHTML(g, size) {
 const s = size || 52;
 const mem = groupMemberContacts(g).slice(0, 2);
 if (!mem.length) return avHTML('', (g && g.name || 'G')[0], s);
 const inner = mem.map((c, i) => `<span class="pp-grp-av-piece pos${i}">${contactAvatarHTML(c, Math.round(s * 0.62))}</span>`).join('');
 return `<span class="pp-grp-av" style="width:${s}px;height:${s}px">${inner}</span>`;
}
function threadAvatarHTML(tid, size) {
 if (isGroupId(tid)) return groupAvatarHTML(getGroup(tid), size);
 return contactAvatarHTML(findContact(tid) || { name: tid }, size);
}
function threadName(tid) {
 if (isGroupId(tid)) { const g = getGroup(tid); return g ? (g.name || 'กลุ่ม') : 'กลุ่ม'; }
 return cname(tid);
}

function startClock() {
 if (ppClockTimer) return;
 const tick = () => {
 const t = ppNow();
 document.querySelectorAll('.pp-clock').forEach(e => e.textContent = t);
 const dl = document.getElementById('pp-home-date'); if (dl) dl.textContent = ppDateLabel();
 };
 tick();
 ppClockTimer = setInterval(tick, 10000);
}
function applyTheme() {
 const frame = document.getElementById('pp-frame');
 if (!frame) return;
 const cfg = getCfg();
 frame.classList.toggle('light', cfg.theme === 'light');
 frame.style.setProperty('--pp-accent', cfg.accent || '#0a84ff');
}
function applyIsland() {
 const island = document.getElementById('pp-island');
 if (island) island.style.display = getCfg().dynamicIsland ? 'flex' : 'none';
}
async function applyWallpaper() {
 const el = document.getElementById('pp-home-wp');
 if (!el) return;
 const cfg = getCfg();
 el.style.filter = `blur(${cfg.homeBlur ?? 6}px)`;
 const wp = cfg.wallpaper || 'aurora';
 if (wp === 'custom') {
 const img = await loadMedia('home-wp');
 if (img) { el.style.background = '#000 center/cover no-repeat'; el.style.backgroundImage = `url(${img})`; return; }
 }
 el.style.backgroundImage = '';
 el.style.background = WALLPAPERS[wp] || WALLPAPERS.aurora;
}
function updateHomeWidgets() {
 const info = periodTodayInfo();
 const pm = document.getElementById('pp-w-period');
 const ps = document.getElementById('pp-w-period-sub');
 if (pm) {
 if (info.onPeriod) { pm.textContent = `วันที่ ${info.dayNum}`; if (ps) ps.textContent = 'มีประจำเดือน'; }
 else if (info.upcomingIn != null && info.upcomingIn >= 0) { pm.textContent = `อีก ${info.upcomingIn} วัน`; if (ps) ps.textContent = phaseLabel(info.phase); }
 else { pm.textContent = '—'; if (ps) ps.textContent = 'ยังไม่มีข้อมูล'; }
 }
 const cfg = getCfg();
 const wm = document.getElementById('pp-w-wallet');
 const ws = document.getElementById('pp-w-wallet-sub');
 if (wm) wm.textContent = fmtMoney(walletBalanceGet());
 if (ws) { const sp = spentToday(); ws.textContent = sp ? `วันนี้ใช้ ${fmtMoney(sp)}` : 'วันนี้ยังไม่ใช้'; }
 // badges
 const totalUnread = Object.values(cfg.unread || {}).reduce((a, b) => a + b, 0);
 // ล้าง badge ทุกตัวก่อน กันค้างจาก nav ที่ไม่ได้เซ็ต
 document.querySelectorAll('.pp-icon-badge').forEach(el => { el.textContent = ''; el.style.display = 'none'; });
 const setBadge = (nav, n) => {
 const el = document.querySelector(`[data-badge="${nav}"]`);
 if (!el) return;
 const v = Number(n) || 0;
 el.textContent = v > 0 ? String(v) : '';
 el.style.display = v > 0 ? 'block' : 'none';
 };
 setBadge('messages', totalUnread);
 setBadge('feed', unreadNotifCount() + unseenMentions() + newsPosts().filter(p => !(cfg.newsSeen || {})[p.id]).length);
 // ★ 1.4.0 เอาแอปข่าวออกจากหน้าโฮมแล้ว — ข่าวรวมอยู่ในเลขของฟีด
}

// ══════════════════════════════════════════════════════════
// nav
// ══════════════════════════════════════════════════════════
function ppOpen() {
 const dlg = document.getElementById('pp-dialog');
 if (!dlg) return;
 applyTheme(); applyIsland(); applyWallpaper(); startClock();
 refreshUserAvatar().then(() => { if (ppCurrentScreen === 'home') updateHomeWidgets(); });
 pruneStories(); updateHomeWidgets(); ppUpdateLogBadge();
 if (typeof dlg.showModal === 'function' && !dlg.open) dlg.showModal();
 else dlg.setAttribute('open', '');
 islandRefresh();
}
function ppClose() {
 const dlg = document.getElementById('pp-dialog');
 if (!dlg) return;
 try { document.activeElement?.blur(); } catch {}
 if (dlg.open && typeof dlg.close === 'function') dlg.close();
 else dlg.removeAttribute('open');
 islandRefresh();
}
function ppRenderScreen(screen, resetTransient) {
 if (screen === 'home') updateHomeWidgets();
 if (screen === 'messages') { renderNotesRow(); renderContactList(); }
 if (screen === 'contacts') renderAddContacts();
 if (screen === 'archive') renderArchive();
 if (screen === 'chat') { if (resetTransient) ppHistShown = HIST_PAGE; renderThread(); }
 if (screen === 'starred') renderStarredScreen();
 if (screen === 'chatsettings') renderChatSettings();
 if (screen === 'groupnew') renderGroupEditor();
 if (screen === 'groupsettings') renderGroupSettings();
 if (screen === 'settings') renderPhoneSettings();
 if (screen === 'syncview') renderSyncView();
 if (screen === 'stickers') renderStickerManager();
 if (screen === 'logview') { if (resetTransient) ppLogSelected.clear(); renderLogView(); }
 if (screen === 'calllog') renderCallLog();
 if (screen === 'feed') renderFeed();
 if (screen === 'newsapp') renderNewsApp();
 if (screen === 'newpost') renderNewPost();
 if (screen === 'postview') renderPost();
 if (screen === 'profedit') renderProfileEdit();
 if (screen === 'account') renderAccountSettings();
 if (screen === 'wallet') renderWallet();
 if (screen === 'period') renderPeriod();
 if (screen === 'helper') renderHelper();
}
function ppRefreshAllViews() {
 updateHomeWidgets();
 ppUpdateLogBadge();
 if (ppCurrentScreen !== 'messages') renderNotesRow();
 ppRenderScreen(ppCurrentScreen, false);
 islandRefresh();
}
function ppNav(screen) {
 ppCurrentScreen = screen;
 document.querySelectorAll('.pp-screen').forEach(s => { s.classList.remove('show', 'pp-enter'); });
 const id = screen === 'home' ? 'pp-home' : 'pp-scr-' + screen;
 const el = document.getElementById(id);
 if (!el) { ppCurrentScreen = 'home'; document.getElementById('pp-home')?.classList.add('show'); ppToast('เร็ว ๆ นี้: ' + screen); return; }
 el.classList.add('show');
 if (screen !== 'home') el.classList.add('pp-enter');
 ppRenderScreen(screen, true);
}
function ppViewing(tid) {
 return ppCurrentScreen === 'chat' && !!document.getElementById('pp-dialog')?.open &&
 ((ppActiveGroup && ppActiveGroup.id === tid) || (ppActiveContact && ppActiveContact.id === tid));
}

// ══════════════════════════════════════════════════════════
// UI primitives — toast / dialog / sheet / prompt / multiselect
// ══════════════════════════════════════════════════════════
function ppToast(msg) {
 const t = document.getElementById('pp-toast');
 if (!t) { console.log('[pp]', msg); return; }
 t.textContent = msg;
 t.classList.add('show');
 clearTimeout(t._timer);
 t._timer = setTimeout(() => t.classList.remove('show'), 2200);
}
function ppHost() { return document.getElementById('pp-frame') || document.body; }
function ppOverlay(cls, inner) {
 const ov = document.createElement('div');
 ov.className = 'pp-ov ' + (cls || 'center');
 ov.innerHTML = inner;
 ppHost().appendChild(ov);
 ov.addEventListener('click', e => { if (e.target === ov) ov.remove(); });
 return ov;
}
function ppAlert(title, bodyHTML) {
 const ov = ppOverlay('center', `<div class="pp-dlg">
 <div class="pp-dlg-title">${esc(title)}</div>
 <div class="pp-dlg-body">${bodyHTML}</div>
 <div class="pp-dlg-row"><button class="pp-btn primary pp-x">เข้าใจแล้ว</button></div>
 </div>`);
 ov.querySelector('.pp-x')?.addEventListener('click', () => ov.remove());
}
function ppConfirm(title, body, onOk, okLabel) {
 const ov = ppOverlay('center', `<div class="pp-dlg">
 <div class="pp-dlg-title">${esc(title)}</div>
 <div class="pp-dlg-body">${esc(body || '')}</div>
 <div class="pp-dlg-row">
 <button class="pp-btn pp-no">ยกเลิก</button>
 <button class="pp-btn danger pp-yes">${esc(okLabel || 'ยืนยัน')}</button>
 </div>
 </div>`);
 ov.querySelector('.pp-no')?.addEventListener('click', () => ov.remove());
 ov.querySelector('.pp-yes')?.addEventListener('click', () => { ov.remove(); onOk && onOk(); });
}
function ppPrompt(title, initial, onOk, opts) {
 const o = opts || {};
 const ov = ppOverlay('center', `<div class="pp-dlg">
 <div class="pp-dlg-title">${esc(title)}</div>
 ${o.hint ? `<div class="pp-hint" style="margin:0 0 8px">${esc(o.hint)}</div>` : ''}
 <textarea class="pp-input-line pp-p-in" rows="${o.rows || 3}" placeholder="${esc(o.placeholder || '')}">${esc(initial || '')}</textarea>
 <div class="pp-dlg-row">
 <button class="pp-btn pp-no">ยกเลิก</button>
 <button class="pp-btn primary pp-yes">${esc(o.okLabel || 'บันทึก')}</button>
 </div>
 </div>`);
 const ta = ov.querySelector('.pp-p-in');
 setTimeout(() => ta?.focus(), 60);
 ov.querySelector('.pp-no')?.addEventListener('click', () => ov.remove());
 ov.querySelector('.pp-yes')?.addEventListener('click', () => { const v = (ta.value || '').trim(); ov.remove(); onOk(v); });
}
function ppSheet(title, items) {
 const acts = items.map((it, i) =>
 `<button class="pp-sheet-act${it.danger ? ' danger' : ''}" data-i="${i}">${it.icon || ''}<span>${esc(it.label)}</span></button>`).join('');
 const ov = ppOverlay('bottom', `<div class="pp-sheet">
 <div class="pp-sheet-grab"></div>
 ${title ? `<div class="pp-sheet-head"><span class="pp-sheet-title">${esc(title)}</span></div>` : ''}
 <div class="pp-sheet-body"><div class="pp-sheet-acts">${acts}</div></div>
 <button class="pp-sheet-cancel">ยกเลิก</button>
 </div>`);
 ov.querySelectorAll('[data-i]').forEach(b => b.addEventListener('click', e => {
 e.stopPropagation();
 const it = items[+b.dataset.i];
 ov.remove();
 it.onClick && it.onClick();
 }));
 ov.querySelector('.pp-sheet-cancel')?.addEventListener('click', () => ov.remove());
}
function ppReplyComposer(opts) {
 const ov = ppOverlay('bottom', `<div class="pp-sheet">
 <div class="pp-sheet-grab"></div>
 <div class="pp-sheet-head"><span class="pp-sheet-title">${esc(opts.title || 'ตอบกลับ')}</span></div>
 <div class="pp-sheet-body" style="padding:0 18px 14px">
 <div class="pp-quote">
 <div class="pp-quote-lb">${esc(opts.quotedLabel || '')}</div>
 <div class="pp-quote-txt">${esc(opts.quoted || '')}</div>
 </div>
 <div style="display:flex;align-items:flex-end;gap:8px">
 <textarea class="pp-input pp-r-in" rows="1" placeholder="พิมพ์ตอบ…">${esc(opts.initial || '')}</textarea>
 <button class="pp-gen pp-r-send">${ICON.send}</button>
 </div>
 </div>
 </div>`);
 const ta = ov.querySelector('.pp-r-in');
 setTimeout(() => ta?.focus(), 60);
 const submit = () => { const v = (ta.value || '').trim(); if (v) { ov.remove(); opts.onOk(v); } };
 ta.addEventListener('input', function () { this.style.height = 'auto'; this.style.height = Math.min(104, this.scrollHeight) + 'px'; });
 ta.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } });
 ov.querySelector('.pp-r-send')?.addEventListener('click', submit);
}
function ppMultiSelect(opts) {
 const chosen = new Set(opts.selected || []);
 const list = opts.items || getContacts().map(c => ({ id: c.id, label: dname(c), avatar: c.avatar }));
 const rowHTML = it =>
  `<button class="pp-ms-row" data-mscid="${esc(it.id)}" data-mslabel="${esc(String(it.label).toLowerCase())}">
   ${avHTML(it.avatar, it.label[0], 36)}
   <span style="flex:1;font-size:15px">${esc(it.label)}</span>
   <span class="pp-ms-check${chosen.has(it.id) ? ' on' : ''}">${chosen.has(it.id) ? ICON.check : ''}</span>
  </button>`;
 const ov = ppOverlay('bottom', `<div class="pp-sheet">
  <div class="pp-sheet-grab"></div>
  <div class="pp-sheet-head">
   <span class="pp-sheet-title">${esc(opts.title || 'เลือก')}</span>
   <button class="pp-btn primary pp-ms-done">เสร็จ</button>
  </div>
  ${list.length > 6 ? `<div class="pp-searchpick"><span class="ic">${ICON.search}</span><input class="pp-ms-search" placeholder="ค้นหาชื่อ"></div>` : ''}
  <div class="pp-sheet-body" id="pp-ms-body">${list.map(rowHTML).join('') || '<div class="pp-empty">ยังไม่มีรายการ</div>'}</div>
 </div>`);
 const bind = () => ov.querySelectorAll('.pp-ms-row').forEach(b => {
  if (b._bound) return;
  b._bound = true;
  b.addEventListener('click', e => {
   e.stopPropagation();
   const id = b.dataset.mscid;
   if (chosen.has(id)) chosen.delete(id); else chosen.add(id);
   const chk = b.querySelector('.pp-ms-check');
   chk.classList.toggle('on', chosen.has(id));
   chk.innerHTML = chosen.has(id) ? ICON.check : '';
  });
 });
 bind();
 const sIn = ov.querySelector('.pp-ms-search');
 if (sIn) {
  sIn.addEventListener('click', e => e.stopPropagation());
  sIn.addEventListener('input', () => {
   const q = sIn.value.trim().toLowerCase();
   ov.querySelectorAll('.pp-ms-row').forEach(b => {
    b.style.display = (!q || (b.dataset.mslabel || '').includes(q)) ? '' : 'none';
   });
  });
 }
 ov.querySelector('.pp-ms-done')?.addEventListener('click', e => { e.stopPropagation(); ov.remove(); opts.onDone([...chosen]); });
}
function ppPickContact(title, onPick, exclude, opts) {
 const o = opts || {};
 const compact = o.compact !== false; // ★ 1.4.1 ย่อเป็นค่าเริ่มต้น
 const all = getContacts().filter(c => c.id !== exclude);
 if (!all.length) { ppToast('ยังไม่มีคอนแทกต์'); return; }
 const av = compact ? 28 : 36;
 const fs = compact ? 14 : 15;
 const rowHTML = c => `<button class="pp-ms-row${compact ? ' pp-ms-compact' : ''}" data-pickcid="${esc(c.id)}" data-picklb="${esc(dname(c).toLowerCase())}">
  ${contactAvatarHTML(c, av)}<span style="flex:1;font-size:${fs}px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(dname(c))}</span>${o.subLabel ? `<span style="font-size:11px;color:var(--pp-txt3);flex-shrink:0">${esc(o.subLabel(c))}</span>` : ''}${ICON.chevron}</button>`;
 const ov = ppOverlay('bottom', `<div class="pp-sheet">
  <div class="pp-sheet-grab"></div>
  <div class="pp-sheet-head"><span class="pp-sheet-title">${esc(title || 'เลือกคน')}</span></div>
  ${all.length > 6 ? `<div class="pp-searchpick"><span class="ic">${ICON.search}</span><input class="pp-pick-search" placeholder="ค้นหาชื่อ"></div>` : ''}
  <div class="pp-sheet-body">${all.map(rowHTML).join('')}</div>
  <button class="pp-sheet-cancel">ยกเลิก</button>
 </div>`);
 ov.querySelectorAll('[data-pickcid]').forEach(b => b.addEventListener('click', e => {
  e.stopPropagation();
  const id = b.dataset.pickcid;
  ov.remove();
  onPick(id);
 }));
 const sIn = ov.querySelector('.pp-pick-search');
 if (sIn) {
  sIn.addEventListener('click', e => e.stopPropagation());
  sIn.addEventListener('input', () => {
   const q = sIn.value.trim().toLowerCase();
   ov.querySelectorAll('[data-pickcid]').forEach(b => { b.style.display = (!q || (b.dataset.picklb || '').includes(q)) ? '' : 'none'; });
  });
 }
 ov.querySelector('.pp-sheet-cancel')?.addEventListener('click', () => ov.remove());
}

// ══════════════════════════════════════════════════════════
// Island
// ══════════════════════════════════════════════════════════
function renderIslandInto(el, state) {
 const isExt = el.id === 'pp-ext-island';
 if (!state) {
 el.classList.remove('pp-island-live');
 if (isExt) { el.style.width = '118px'; el.style.height = '33px'; el.style.borderRadius = '20px'; el.style.justifyContent = 'center'; el.style.padding = '0'; el.style.gap = '0'; }
 setTimeout(() => { if (!el.classList.contains('pp-island-live')) { el.innerHTML = ''; delete el.dataset.cid; if (isExt) el.style.display = 'none'; } }, 560);
 return;
 }
 el.dataset.cid = state.cid || '';
 if (isExt) el.style.display = 'flex';
 const av = state.avatar
 ? `<img class="pp-island-av" src="${esc(state.avatar)}" onerror="this.style.visibility='hidden'">`
 : `<span class="pp-island-av pp-island-av-fb">${esc((state.name || '?')[0])}</span>`;
 const body = state.kind === 'typing'
 ? `<div class="pp-island-typing"><span></span><span></span><span></span></div>`
 : `<div class="pp-island-msg">${esc(state.text || '')}</div>`;
 el.innerHTML = `${av}<div class="pp-island-body"><div class="pp-island-name">${esc(state.name)}${state.callLive ? ' · แตะกลับเข้าสาย' : ''}</div>${body}</div>`;
 el.dataset.calllive = state.callLive ? '1' : '';
 void el.offsetWidth;
 requestAnimationFrame(() => {
 el.classList.add('pp-island-live');
 if (isExt) { el.style.width = 'min(340px,92vw)'; el.style.height = '66px'; el.style.borderRadius = '31px'; el.style.justifyContent = 'flex-start'; el.style.padding = '0 16px'; el.style.gap = '12px'; }
 });
}
function islandRefresh() {
 const internal = document.getElementById('pp-island');
 const external = document.getElementById('pp-ext-island');
 const open = !!document.getElementById('pp-dialog')?.open;
 if (internal) { if (open && getCfg().dynamicIsland && ppIslandState) renderIslandInto(internal, ppIslandState); else renderIslandInto(internal, null); }
 if (external) { const show = !open && ppIslandState && (getCfg().islandScope === 'always' || ppIslandState.notify); renderIslandInto(external, show ? ppIslandState : null); }
}
function islandTyping(c) { clearTimeout(ppIslandTimer); ppIslandState = { cid: c.id, name: dname(c), avatar: c.avatar, kind: 'typing' }; islandRefresh(); }
function islandStatus(text) { clearTimeout(ppIslandTimer); ppIslandState = { cid: '', name: 'Pocket Phone', avatar: '', kind: 'msg', text }; islandRefresh(); }
function islandNotify(c, text) {
 if (c && c.id && isMuted(c.id)) return;
 clearTimeout(ppIslandTimer);
 ppIslandState = { cid: c ? c.id : '', name: c ? (c.name || dname(c)) : 'Pocket Phone', avatar: c ? c.avatar : '', kind: 'msg', text, notify: true };
 islandRefresh();
 ppIslandTimer = setTimeout(() => { ppIslandState = null; islandRefresh(); }, 4200);
}
function islandShowReplies(c, lines) {
 clearTimeout(ppIslandTimer);
 let i = 0;
 const step = () => {
 if (i >= lines.length) { ppIslandState = null; islandRefresh(); return; }
 ppIslandState = { cid: c.id, name: dname(c), avatar: c.avatar, kind: 'msg', text: lines[i] };
 islandRefresh(); i++;
 ppIslandTimer = setTimeout(step, 2600);
 };
 step();
}
function islandCollapse() { clearTimeout(ppIslandTimer); ppIslandState = null; islandRefresh(); }

// ══════════════════════════════════════════════════════════
// notes row
// ══════════════════════════════════════════════════════════
function renderNotesRow() {
 const row = document.getElementById('pp-notes-row');
 if (!row) return;
 const un = getUserNote();
 let html = `<div class="pp-note-item" data-usernote="1">
 <div class="pp-note-av-wrap">
 ${un ? `<div class="pp-note-bubble">${esc(un.text.slice(0, 24))}${un.text.length > 24 ? '…' : ''}</div>`
 : `<div class="pp-note-bubble pp-note-add">โน้ต…</div>`}
 ${userAvatarHTML(58)}
 </div>
 <div class="pp-note-name">${esc(getUserDisplayName())}</div>
 </div>`;
 const cats = { pin: [], main: [], npc: [] };
 getContacts().forEach(c => { const bn = getBotNote(c.id); if (!bn) return; cats[noteCategory(c.id)].push({ c, bn }); });
 const section = arr => arr.map(({ c, bn }) => `
 <div class="pp-note-item" data-botnote="${esc(c.id)}">
 <div class="pp-note-av-wrap">
 <div class="pp-note-bubble">${esc(bn.text.slice(0, 24))}${bn.text.length > 24 ? '…' : ''}</div>
 ${contactAvatarHTML(c, 58)}
 </div>
 <div class="pp-note-name">${esc(dname(c))}</div>
 </div>`).join('');
 const parts = [];
 if (cats.pin.length) parts.push(`<div class="pp-note-sep" data-label="ปักหมุด"></div>${section(cats.pin)}`);
 if (cats.main.length) parts.push(`<div class="pp-note-sep" data-label="หลัก"></div>${section(cats.main)}`);
 if (cats.npc.length) parts.push(`<div class="pp-note-sep" data-label="NPC"></div>${section(cats.npc)}`);
 row.innerHTML = html + parts.join('');
}
function ppOpenBotNote(cid) {
 const bn = getBotNote(cid), c = findContact(cid);
 if (!bn || !c) return;
 const ov = ppOverlay('center', `<div class="pp-dlg">
 <div style="display:flex;align-items:center;gap:9px;margin-bottom:9px">${contactAvatarHTML(c, 34)}
 <div><div style="font-size:14px;font-weight:700">${esc(dname(c))}</div>
 <div style="font-size:11px;color:var(--pp-txt3)">${esc(fmtNoteAge(bn.ts))}</div></div></div>
 <div class="pp-quote"><div class="pp-quote-txt">${esc(bn.text)}</div></div>
 <div class="pp-dlg-row">
 <button class="pp-btn pp-no">ปิด</button>
 <button class="pp-btn primary pp-yes">ตอบกลับ</button>
 </div>
 </div>`);
 ov.querySelector('.pp-no')?.addEventListener('click', () => ov.remove());
 ov.querySelector('.pp-yes')?.addEventListener('click', () => {
 ov.remove();
 ppReplyComposer({
 title: `ตอบโน้ตของ ${dname(c)}`, quotedLabel: `โน้ตของ ${dname(c)}`, quoted: bn.text,
 onOk: text => {
 pushThreadMsg(cid, { from: 'me', text, replyTo: { kind: 'note', text: bn.text, author: dname(c) } });
 ppLog('note', `ตอบโน้ตของ ${dname(c)} ("${bn.text.slice(0, 60)}") ว่า "${text}"`);
 ppActiveContact = c; ppActiveGroup = null; ppNav('chat');
 }
 });
 });
}

// ══════════════════════════════════════════════════════════
// thread data helpers
// ══════════════════════════════════════════════════════════
function pushThreadMsg(id, msg) {
 getThread(id).push(Object.assign({ ts: Date.now(), mid: newMid() }, msg));
 saveCfg();
}
function msgPreview(m) {
 if (!m) return 'แตะเพื่อเริ่มแชท';
 if (m.from === 'sys' || m.type === 'nickname' || m.type === 'sysline') return m.text || '';
 if (m.unsent) return (m.senderName ? m.senderName + ': ' : '') + 'ยกเลิกข้อความแล้ว';
 const pre = m.senderName ? m.senderName + ': ' : '';
 if (m.type === 'call') return pre + (m.dir === 'out' ? 'โทรออก' : 'สายเข้า');
 if (m.type === 'transfer') return pre + (m.from === 'me' ? 'โอนเงิน ' : 'ได้รับโอน ') + fmtMoney(m.amount);
 if (m.type === 'image') return pre + (m.caption ? `[รูป] ${m.caption}` : '[รูปภาพ]');
 if (m.type === 'voice') return pre + '(ข้อความเสียง)';
 if (m.type === 'sticker') return pre + `[สติกเกอร์${m.label ? ' ' + m.label : ''}]`;
 if (m.type === 'sharedpost') return pre + '[แชร์โพสต์]';
 if (m.type === 'location') return pre + `[ตำแหน่ง] ${m.place || ''}`;
 if (m.type === 'contactcard') return pre + `[การ์ดคอนแทกต์] ${cname(m.cardId)}`;
 if (m.type === 'poll') return pre + `[โพล] ${m.question || ''}`;
 if (m.type === 'gift') return pre + `[ของขวัญ] ${m.giftName || ''}`;
 const rp = m.replyTo ? (m.replyTo.kind === 'story' ? 'ตอบสตอรี่: ' : m.replyTo.kind === 'msg' ? 'ตอบ: ' : 'ตอบโน้ต: ') : '';
 return pre + rp + (m.text || '');
}
/** ข้อความสำหรับ Action Log */
function msgLogText(m) {
 if (!m) return '';
 if (m.type === 'image') return m.caption ? `ส่งรูป (คำบรรยาย: ${m.caption})` : 'ส่งรูป (ไม่ได้บรรยาย)';
 if (m.type === 'voice') return `ส่งข้อความเสียงว่า "${m.text}"`;
 if (m.type === 'sticker') return `ส่งสติกเกอร์${m.label ? ` "${m.label}"` : ''}`;
 if (m.type === 'location') return `ส่งตำแหน่ง "${m.place}"${m.note ? ` (${m.note})` : ''}`;
 if (m.type === 'contactcard') return `ส่งการ์ดคอนแทกต์ของ ${cname(m.cardId)}`;
 if (m.type === 'poll') return `สร้างโพล "${m.question}" ตัวเลือก: ${(m.options || []).map(o => o.text).join(' / ')}`;
 if (m.type === 'gift') return `ส่งของขวัญ "${m.giftName}"${m.amount ? ` มูลค่า ${fmtMoney(m.amount)}` : ''}`;
 if (m.type === 'sharedpost') { const p = findPost(m.postId); return `แชร์โพสต์${p ? ` "${(p.text || '[รูป]').slice(0, 60)}"` : ''}`; }
 const rp = m.replyTo ? `(ตอบ${m.replyTo.kind === 'story' ? 'สตอรี่' : m.replyTo.kind === 'msg' ? 'ข้อความ' : 'โน้ต'} "${String(m.replyTo.text || '').slice(0, 40)}") ` : '';
 return `${rp}"${m.text}"`;
}
function threadLabel(tid) {
 return isGroupId(tid) ? `กลุ่ม ${threadName(tid)}` : threadName(tid);
}

// ══════════════════════════════════════════════════════════
// contact list + swipe
// ══════════════════════════════════════════════════════════
function threadMatchesFilter(tid, f) {
 if (!f) return true;
 const q = f.toLowerCase();
 if (threadName(tid).toLowerCase().includes(q)) return true;
 return getThread(tid).some(m => String(m.text || m.caption || '').toLowerCase().includes(q));
}
function renderContactList() {
 const list = document.getElementById('pp-contact-list');
 if (!list) return;
 document.querySelectorAll('#pp-chat-tabs button').forEach(b => b.classList.toggle('on', b.dataset.chattab === ppChatTab));

 const rowInner = (tid, isGroup) => {
 const th = getThread(tid);
 const last = th[th.length - 1];
 const typing = ppGeneratingId === tid;
 const draft = (getCfg().drafts || {})[threadKey(tid)];
 const preview = typing ? 'กำลังพิมพ์…'
 : (draft ? `ร่าง: ${draft}`
 : (last ? msgPreview(last) : (isGroup ? `สมาชิก ${(getGroup(tid)?.members || []).length} คน` : 'แตะเพื่อเริ่มแชท')));
 const n = unreadOf(tid);
 const muted = isMuted(tid);
 return `<div class="pp-row${muted ? ' muted' : ''}" data-tid="${esc(tid)}">
 ${threadAvatarHTML(tid, 52)}
 <div class="pp-row-meta">
 <div class="pp-row-name">${esc(threadName(tid))}
 ${isGroup ? `<span style="font-size:11px;color:var(--pp-txt3);font-weight:400">${(getGroup(tid)?.members || []).length} คน</span>` : ''}
 ${isPinned(tid) ? ICON.pin : ''}${muted ? ICON.bellOff : ''}</div>
 <div class="pp-row-sub${typing ? ' pp-typing-txt' : ''}">${esc(preview)}</div>
 </div>
 <div class="pp-row-right">
 <span class="pp-row-time">${esc(last ? fmtListTime(last.ts) : '')}</span>
 ${n ? `<span class="pp-badge">${n > 99 ? '99+' : n}</span>` : ''}
 </div>
 </div>`;
 };
 const swipeWrap = (tid, isGroup) => `<div class="pp-swipe" data-swipe="${esc(tid)}">
 <div class="pp-swipe-acts">
 <button class="pp-sw-pin" data-sw="pin" data-tid="${esc(tid)}">${ICON.pin}<span>${isPinned(tid) ? 'เลิกปัก' : 'ปักหมุด'}</span></button>
 <button class="pp-sw-mute" data-sw="mute" data-tid="${esc(tid)}">${isMuted(tid) ? ICON.bell : ICON.bellOff}<span>${isMuted(tid) ? 'เปิดเสียง' : 'ปิดเสียง'}</span></button>
 <button class="pp-sw-arch" data-sw="arch" data-tid="${esc(tid)}">${ICON.archive}<span>เก็บ</span></button>
 <button class="pp-sw-del" data-sw="del" data-tid="${esc(tid)}">${ICON.trash}<span>ลบ</span></button>
 </div>
 <div class="pp-swipe-inner">${rowInner(tid, isGroup)}</div>
 </div>`;

 const f = ppMsgFilter;
 let groups = getGroups().filter(g => !isArchived(g.id)).map(g => g.id);
 let contacts = getContacts().filter(c => !isArchived(c.id)).map(c => c.id);
 if (ppScopeActive()) {
 contacts = contacts.filter(id => { const c = findContact(id); return c && ppContactInScope(c); });
 groups = groups.filter(id => { const g = getGroup(id); return g && (g.members || []).some(mid => { const cc = findContact(mid); return cc && ppContactInScope(cc); }); });
 }
 const scopeBar = currentCharacterId()
 ? `<div class="pp-scope-bar" id="pp-scope-toggle">${getCfg().ppShowAllContacts
 ? 'แสดงทุกคอนแทกต์ · แตะเพื่อโฟกัสเฉพาะตัวละครที่เปิดอยู่'
 : 'โฟกัส ' + esc(cname(currentCharacterId())) + ' + NPC ของเขา · แตะเพื่อแสดงทั้งหมด'}</div>`
 : '';

 if (f) {
 groups = groups.filter(id => threadMatchesFilter(id, f));
 contacts = contacts.filter(id => threadMatchesFilter(id, f));
 } else if (ppChatTab === 'unread') {
 groups = groups.filter(id => unreadOf(id) > 0);
 contacts = contacts.filter(id => unreadOf(id) > 0);
 } else {
 contacts = contacts.filter(id => contactCategory(findContact(id)) === ppChatTab);
 if (ppChatTab === 'npc') groups = [];
 if (ppChatTab === 'pin') groups = groups.filter(id => isPinned(id));
 }
 groups.sort((a, b) => lastTs(b) - lastTs(a));
 contacts.sort((a, b) => lastTs(b) - lastTs(a));

 if (!groups.length && !contacts.length) {
 const arch = (getCfg().archivedChats || []).length;
 list.innerHTML = scopeBar + `<div class="pp-empty">${ICON.messages}<br>${f ? 'ไม่พบผลลัพธ์' : ppChatTab === 'unread' ? 'อ่านครบทุกแชทแล้ว' : (ppScopeActive() ? 'ยังไม่มีคนคุยกับตัวละครนี้' : 'ยังไม่มีคนคุยในหมวดนี้')}
 <span>${f ? 'ลองคำอื่น' : 'แตะปุ่มมุมขวาบนเพื่อเพิ่มคนคุย'}</span></div>
 ${arch ? `<div class="pp-row" data-nav="archive">${ICON.archive}<div class="pp-row-meta"><div class="pp-row-name">คลังเก็บ</div><div class="pp-row-sub">${arch} แชท</div></div>${ICON.chevron}</div>` : ''}`;
 return;
 }
 let html = '';
 if (groups.length) html += `<div class="pp-list-head">แชทกลุ่ม</div>` + groups.map(id => swipeWrap(id, true)).join('');
 if (contacts.length) {
 if (groups.length) html += `<div class="pp-list-head">${ppChatTab === 'pin' ? 'ปักหมุด' : ppChatTab === 'npc' ? 'NPC' : ppChatTab === 'unread' ? 'ยังไม่อ่าน' : 'ตัวละคร'}</div>`;
 html += contacts.map(id => swipeWrap(id, false)).join('');
 }
 const arch = (getCfg().archivedChats || []).length;
 if (arch && !f) html += `<div class="pp-row" data-nav="archive" style="margin-top:8px">${ICON.archive}<div class="pp-row-meta"><div class="pp-row-name">คลังเก็บ</div><div class="pp-row-sub">${arch} แชท</div></div>${ICON.chevron}</div>`;
 list.innerHTML = scopeBar + html;
 bindSwipeRows(list);
}
function bindSwipeRows(root) {
 root.querySelectorAll('.pp-swipe').forEach(wrap => {
 const inner = wrap.querySelector('.pp-swipe-inner');
 let x0 = 0, y0 = 0, open = false, active = false;
 wrap.addEventListener('touchstart', e => { x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; active = false; }, { passive: true });
 wrap.addEventListener('touchmove', e => {
 const dx = e.touches[0].clientX - x0, dy = e.touches[0].clientY - y0;
 if (!active && Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy) * 1.4) { active = true; wrap.classList.add('dragging'); }
 if (active) {
 const base = open ? -288 : 0;
 const shift = Math.max(-288, Math.min(0, base + dx));
 inner.style.transform = `translateX(${shift}px)`;
 }
 }, { passive: true });
 wrap.addEventListener('touchend', e => {
 wrap.classList.remove('dragging');
 if (!active) return;
 const dx = e.changedTouches[0].clientX - x0;
 open = open ? dx < 60 : dx < -60;
 inner.style.transform = open ? 'translateX(-288px)' : '';
 wrap.classList.toggle('open', open);
 active = false;
 }, { passive: true });
 });
}
function renderArchive() {
 const list = document.getElementById('pp-archive-list');
 if (!list) return;
 const ids = (getCfg().archivedChats || []);
 if (!ids.length) { list.innerHTML = `<div class="pp-empty">${ICON.archive}<br>คลังเก็บว่าง</div>`; return; }
 list.innerHTML = ids.map(tid => {
 const th = getThread(tid), last = th[th.length - 1];
 return `<div class="pp-row" data-unarch="${esc(tid)}">
 ${threadAvatarHTML(tid, 48)}
 <div class="pp-row-meta"><div class="pp-row-name">${esc(threadName(tid))}</div>
 <div class="pp-row-sub">${esc(last ? msgPreview(last) : '')}</div></div>
 <button class="pp-btn" style="padding:6px 12px">เอาออก</button>
 </div>`;
 }).join('');
}
let ppAddFilter = '';
function renderAddContacts() {
 const list = document.getElementById('pp-add-list');
 if (!list) return;
 const chars = listStCharacters();
 const added = new Set(getContacts().map(c => c.id));
 const head = `<div class="pp-list-head">คอนแทกต์</div>
  <button class="pp-btn primary wide" id="pp-create-npc-row" style="margin:2px 16px 10px;width:calc(100% - 32px)">${ICON.plus}สร้าง NPC เอง</button>
  <div class="pp-searchpick"><span class="ic">${ICON.search}</span>
   <input id="pp-add-search" placeholder="ค้นหาชื่อตัวละคร" value="${esc(ppAddFilter)}"></div>`;
 if (!chars.length) { list.innerHTML = head + `<div class="pp-empty">${ICON.users}<br>ไม่พบตัวละครใน SillyTavern</div>`; return; }
 const q = ppAddFilter.trim().toLowerCase();
 const shown = q ? chars.filter(c => c.name.toLowerCase().includes(q)) : chars;
 list.innerHTML = head + (shown.length ? shown.map(c => `<div class="pp-row">
  ${contactAvatarHTML(c, 48)}
  <div class="pp-row-meta"><div class="pp-row-name">${esc(c.name)}</div></div>
  ${added.has(c.id) ? `<span style="color:#30d158;font-size:14px;font-weight:600">เพิ่มแล้ว</span>`
   : `<button class="pp-btn primary" data-add="${esc(c.id)}" style="padding:7px 15px">เพิ่ม</button>`}
 </div>`).join('') : `<div class="pp-empty">${ICON.search}<br>ไม่พบชื่อนี้</div>`);
 const sIn = document.getElementById('pp-add-search');
 if (sIn) {
  sIn.addEventListener('input', () => {
   ppAddFilter = sIn.value;
   const q2 = ppAddFilter.trim().toLowerCase();
   list.querySelectorAll('.pp-row').forEach(r => {
    const nm = (r.querySelector('.pp-row-name')?.textContent || '').toLowerCase();
    r.style.display = (!q2 || nm.includes(q2)) ? '' : 'none';
   });
  });
 }
}
function ppOpenThread(tid) {
 if (isGroupId(tid)) { const g = getGroup(tid); if (!g) return; ppActiveGroup = g; ppActiveContact = null; }
 else { const c = findContact(tid); if (!c) return; ppActiveContact = c; ppActiveGroup = null; }
 clearUnread(tid);
 updateHomeWidgets(); // รีเฟรชเลขแดงบนไอคอนแอปทันทีหลังเปิดอ่าน
 ppHistShown = HIST_PAGE; ppChatFilter = ''; ppSelectMode = false; ppSelected.clear();
 ppNav('chat');
}
function ppAddContact(id) {
 const c = listStCharacters().find(x => x.id === id);
 if (!c) return;
 const cfg = getCfg();
 if (!cfg.contacts.find(x => x.id === id)) {
 cfg.contacts.push({ id: c.id, name: c.name, avatar: c.avatar });
 saveCfg();
 ppLog('chat', `เพิ่ม ${c.name} เข้าคอนแทกต์`);
 ppToast(`เพิ่ม ${c.name} แล้ว`);
 renderAddContacts();
 }
}
function ppPickLorebook(cid) {
 const c = findContact(cid);
 if (!c) return;
 const books = ppListLorebooks();
 if (!books.length) { ppToast('ไม่พบ Lorebook ใน SillyTavern'); return; }
 const items = [{ label: 'ไม่ใช้ Lorebook', icon: ICON.close, onClick: () => { c.loreBook = ''; c.loreUids = []; c.loreCache = ''; saveCfg(); ppToast('เอา Lorebook ออกแล้ว'); } }];
 books.forEach(b => items.push({
 label: b + (c.loreBook === b ? ' ·' : ''), icon: ICON.compass,
 onClick: () => {
 c.loreBook = b; c.loreUids = []; c.loreCache = ''; saveCfg();
 ppSheet(`${b}`, [
 { label: 'ใช้ทั้งเล่ม', icon: ICON.check, onClick: async () => { c.loreUids = []; saveCfg(); await ppFetchLoreForContact(cid); ppToast('ผูกทั้งเล่มแล้ว'); } },
 { label: 'เลือกบางหัวข้อ', icon: ICON.grid, onClick: () => ppPickLoreEntries(cid, b) },
 ]);
 }
 }));
 ppSheet('เลือก Lorebook', items.slice(0, 40));
}
async function ppPickLoreEntries(cid, bookName) {
 const c = findContact(cid);
 if (!c) return;
 islandStatus('กำลังโหลด Lorebook…');
 const entries = await ppLoadLoreEntries(bookName);
 islandCollapse();
 if (!entries.length) { ppToast('เล่มนี้ไม่มีหัวข้อที่ใช้ได้'); return; }
 ppMultiSelect({
 title: 'เลือกหัวข้อที่จะให้ NPC รู้',
 selected: Array.isArray(c.loreUids) ? c.loreUids : [],
 items: entries.map(e => ({ id: e.uid, label: e.title + (e.disabled ? ' (ปิดใน ST)' : ''), avatar: '' })),
 onDone: async arr => {
 c.loreUids = arr; c.loreCache = ''; saveCfg();
 await ppFetchLoreForContact(cid);
 ppToast(arr.length ? `ผูก ${arr.length} หัวข้อแล้ว` : 'ผูกทั้งเล่มแล้ว');
 }
 });
}
function ppCreateCustomNpc() {
 ppPrompt('ชื่อ NPC', '', name => {
 name = (name || '').trim();
 if (!name) return;
 ppPrompt('บุคลิก / คำอธิบาย NPC', '', desc => {
 const chars = listStCharacters();
 // สร้าง NPC จริงหลังเลือกต้นแบบ + ถามรูปปก
 const finalize = (baseId, avatarDataUrl) => {
 const cfg = getCfg();
 const npc = {
 id: 'npc:' + newId(), name, avatar: '', npc: true, customNpc: true,
 npcDesc: (desc || '').trim(), baseCharId: baseId || '',
 useBaseContext: !!baseId,
 };
 cfg.contacts.push(npc);
 const done = () => {
 saveCfg();
 ppLog('chat', `สร้าง NPC "${name}"${baseId ? ` อ้างอิงบุคลิกจาก ${listStCharacters().find(x => x.id === baseId)?.name || baseId}` : ''}`);
 ppToast(`สร้าง NPC ${name} แล้ว`);
 ppActiveContact = npc; ppActiveGroup = null; ppNav('chat');
 setTimeout(() => ppPickLorebook(npc.id), 400); // ถามเรื่อง Lorebook ต่อทันที
 };
 if (avatarDataUrl) {
 const key = 'npcav-' + npc.id;
 saveMedia(key, avatarDataUrl).then(ok => { if (ok) npc.avatar = avatarDataUrl; done(); });
 } else done();
 };
 // เลือกต้นแบบ → ถามรูปปก
 const askAvatar = baseId => {
 ppSheet('รูปปก NPC', [
 { label: 'ใช้ตัวอักษรตัวแรก (ไม่มีรูป)', icon: ICON.person, onClick: () => finalize(baseId, '') },
 { label: 'อัปโหลดรูปปก', icon: ICON.image, onClick: () => {
 const inp = document.getElementById('pp-npc-av-file');
 if (!inp) { finalize(baseId, ''); return; }
 inp.onchange = async e => {
 const f = e.target.files && e.target.files[0];
 e.target.value = ''; inp.onchange = null;
 if (!f) { finalize(baseId, ''); return; }
 const dataUrl = await ppReadImageFile(f);
 if (!dataUrl) { ppToast('อ่านไฟล์รูปไม่ได้'); finalize(baseId, ''); return; }
 finalize(baseId, dataUrl);
 };
 inp.click();
 } },
 ]);
 };
 const items = [{ label: 'ไม่อ้างอิงใคร', icon: ICON.person, onClick: () => askAvatar('') }];
 chars.forEach(c => items.push({ label: `อ้างอิงจาก ${c.name}`, icon: ICON.users, onClick: () => askAvatar(c.id) }));
 ppSheet('อ้างอิงบุคลิกจากตัวละครหลักตัวไหน', items);
 }, { rows: 4, placeholder: 'เช่น พี่ชายจอมกวน พูดตรง ชอบแซว' });
 }, { rows: 1 });
}
function ppTogglePin(tid) {
 const cfg = getCfg();
 const i = cfg.pinned.indexOf(tid);
 if (i >= 0) cfg.pinned.splice(i, 1); else cfg.pinned.push(tid);
 saveCfg();
 ppLogMinor('misc', i >= 0 ? `เลิกปักหมุดแชท ${threadLabel(tid)}` : `ปักหมุดแชท ${threadLabel(tid)}`);
 renderContactList();
 ppToast(i >= 0 ? 'เลิกปักหมุด' : 'ปักหมุดแล้ว');
}
function ppToggleMute(tid) {
 const cfg = getCfg();
 const i = cfg.mutedChats.indexOf(tid);
 if (i >= 0) cfg.mutedChats.splice(i, 1); else cfg.mutedChats.push(tid);
 saveCfg();
 ppLogMinor('misc', i >= 0 ? `เปิดเสียงแจ้งเตือนแชท ${threadLabel(tid)}` : `ปิดเสียงแจ้งเตือนแชท ${threadLabel(tid)}`);
 renderContactList();
 ppToast(i >= 0 ? 'เปิดเสียงแล้ว' : 'ปิดเสียงแล้ว');
}
function ppToggleArchive(tid) {
 const cfg = getCfg();
 const i = cfg.archivedChats.indexOf(tid);
 if (i >= 0) cfg.archivedChats.splice(i, 1); else cfg.archivedChats.push(tid);
 saveCfg();
 ppLogMinor('misc', i >= 0 ? `เอาแชท ${threadLabel(tid)} ออกจากคลังเก็บ` : `เก็บแชท ${threadLabel(tid)} เข้าคลัง`);
 renderContactList();
 if (ppCurrentScreen === 'archive') renderArchive();
 ppToast(i >= 0 ? 'เอาออกจากคลังแล้ว' : 'เก็บเข้าคลังแล้ว');
}
function ppDeleteChat(tid) {
 ppConfirm('ลบแชทนี้', `ลบแชทกับ ${threadName(tid)} ทั้งหมด? กู้คืนไม่ได้`, () => {
 const cfg = getCfg();
 if (isGroupId(tid)) cfg.groups = cfg.groups.filter(g => g.id !== tid);
 else cfg.contacts = cfg.contacts.filter(c => c.id !== tid);
 (cfg.threads[tid] || []).forEach(m => { if (m.mediaKey) delMedia(m.mediaKey); });
 delete cfg.threads[tid]; delete cfg.chatStyle[tid]; delete cfg.starred[tid];
 delete cfg.drafts[tid]; delete cfg.unread[tid]; delete cfg.scheduled[tid];
 if (cfg.botNotes) delete cfg.botNotes[tid];
 if (cfg.botWallets) delete cfg.botWallets[tid];
 cfg.pinned = cfg.pinned.filter(x => x !== tid);
 cfg.mutedChats = cfg.mutedChats.filter(x => x !== tid);
 cfg.archivedChats = cfg.archivedChats.filter(x => x !== tid);
 cfg.callLog = (cfg.callLog || []).filter(l => l.cid !== tid);
 cfg.groups.forEach(g => { g.members = (g.members || []).filter(m => m !== tid); });
 saveCfg();
 ppLog('chat', `ลบแชทกับ ${threadName(tid)} ทั้งหมด`);
 renderNotesRow(); renderContactList();
 ppToast('ลบแชทแล้ว');
 }, 'ลบ');
}

// ══════════════════════════════════════════════════════════
// bubble rendering
// ══════════════════════════════════════════════════════════
function replyHeaderHTML(rt) {
 if (!rt) return '';
 const label = rt.kind === 'story' ? 'ตอบสตอรี่' : rt.kind === 'msg' ? 'ตอบข้อความ' : 'ตอบโน้ต';
 const warp = rt.targetMid ? ` data-warp="${esc(rt.targetMid)}"` : '';
 return `<div class="pp-reply-head"${warp}>
 <div class="pp-reply-head-label">${esc(label)}${rt.author ? ' · ' + esc(rt.author) : ''}${rt.targetMid ? ICON.goto : ''}</div>
 <div class="pp-reply-head-txt">${esc(String(rt.text || '').slice(0, 80))}</div>
 </div>`;
}
function sharedPostCardHTML(m, idx) {
 const p = findPost(m.postId);
 if (!p) return `<div class="pp-shared-card"><div class="pp-shared-gone">โพสต์นี้ถูกลบแล้ว</div></div>`;
 return `<div class="pp-shared-card" data-openpost="${esc(p.id)}">
 <div class="pp-shared-top">
 ${avHTML(p.author === 'user' ? ppUserAvatarCache : (findContact(p.author)?.avatar), postAuthorLabel(p)[0], 26)}
 <span class="pp-shared-name">${esc(postAuthorLabel(p))}</span>
 <button class="pp-shared-more" data-sharedmenu="${idx}">${ICON.menu}</button>
 </div>
 ${p.text ? `<div class="pp-shared-text">${esc(String(p.text).slice(0, 120))}</div>` : ''}
 ${(p.mediaKeys && p.mediaKeys[0]) ? `<div class="pp-shared-img" data-sharedimg="${esc(p.id)}"></div>` : ''}
 </div>`;
}
function pollHTML(m, idx) {
 const total = (m.options || []).reduce((s, o) => s + (o.votes || []).length, 0);
 const opts = (m.options || []).map((o, i) => {
 const v = (o.votes || []).length;
 const pct = total ? Math.round(v / total * 100) : 0;
 const mine = (o.votes || []).includes('user');
 return `<div class="pp-poll-opt" data-vote="${idx}:${i}">
 <div class="pp-poll-fill" style="width:${pct}%"></div>
 <div class="pp-poll-lb"><span>${mine ? ICON.check : ''} ${esc(o.text)}</span><span>${v ? pct + '%' : ''}</span></div>
 </div>`;
 }).join('');
 return `<div class="pp-poll"><div class="pp-poll-q">${ICON.poll} ${esc(m.question)}</div>${opts}
 <div class="pp-poll-total">${total ? `${total} โหวต` : 'ยังไม่มีใครโหวต'}</div></div>`;
}
function transferBrowHTML(m, idx) {
 const out = m.from === 'me';
 const pending = !m.status || m.status === 'pending';
 const canAct = !out && pending;
 const status = m.status === 'accepted' ? 'รับเงินแล้ว' : m.status === 'declined' ? 'ปฏิเสธแล้ว' : (out ? 'รอผู้รับเปิด' : 'แตะรับเงินด้านล่าง');
 return `<div class="pp-brow ${out ? 'out' : 'in'}" data-mid="${esc(m.mid || '')}">
 <div class="pp-brow-col"><div class="pp-transfer ${out ? 'out' : 'in'}${m.status === 'declined' ? ' declined' : ''}" data-msgidx="${idx}">
 <div class="pp-transfer-top">${ICON.transfer}<span>${out ? 'โอนเงิน' : 'ได้รับโอน'}</span></div>
 <div class="pp-transfer-amt">${esc(fmtMoney(m.amount))}</div>
 ${m.note ? `<div class="pp-transfer-note">${esc(m.note)}</div>` : ''}
 <div class="pp-transfer-status">${esc(status)}</div>
 ${canAct ? `<div class="pp-transfer-acts">
 <button class="pp-transfer-decline" data-transdec="${idx}">ปฏิเสธ</button>
 <button class="pp-transfer-accept" data-transacc="${idx}">รับเงิน</button></div>` : ''}
 </div></div></div>`;
}
function browHTML(m, idx, grouped, tail, groupMode, tid) {
 // ★ 1.4.0 บรรทัดระบบกลางจอ (ชื่อเล่นที่บอทตั้ง / ถูกเพิ่มเข้ากลุ่ม)
 if (m.from === 'sys' || m.type === 'nickname' || m.type === 'sysline') {
  const ic = m.type === 'nickname' ? ICON.compose : ICON.users;
  return `<div class="pp-sysline" data-mid="${esc(m.mid || '')}">${ic}${esc(m.text || '')}</div>`;
 }
 if (m.type === 'call') {
 const out = m.dir === 'out';
 return `<div class="pp-brow ${out ? 'out' : 'in'}" data-mid="${esc(m.mid || '')}">
 <div class="pp-brow-col"><div class="pp-callmsg ${out ? 'out' : 'in'}${m.missed ? ' missed' : ''}" data-msgidx="${idx}">
 <span class="pp-callmsg-ic">${ICON.phoneApp}</span>
 <span class="pp-callmsg-body">
 <span class="pp-callmsg-title">${out ? 'โทรออก' : 'สายเข้า'}${m.missed ? ' · ไม่ได้รับ' : ''}</span>
 <span class="pp-callmsg-sub">${esc(m.text || '')}</span></span>
 </div></div></div>`;
 }
 if (m.type === 'transfer') return transferBrowHTML(m, idx);

 const out = m.from === 'me';

 // ★ ข้อความที่ถูกยกเลิก (unsend) — แตะเพื่อแอบส่อง (1.4.0: แสดงว่าอีกฝ่ายอ่านทันไหม)
 if (m.unsent) {
 const canPeek = out ? true : (m.letUserPeek !== false && getCfg().unsendPeekEnabled !== false);
 const seenTag = out ? (m.seenBeforeUnsend ? 'อ่านทันไปก่อน' : 'ยกเลิกทัน') : '';
 return `<div class="pp-brow ${out ? 'out' : 'in'}" data-mid="${esc(m.mid || '')}">
 <div class="pp-brow-col">
 <div class="pp-bubble tail pp-bubble-unsent peekable" data-peekmid="${esc(m.mid || '')}" data-msgidx="${idx}">
 ${ICON.ban}<span>ยกเลิกข้อความแล้ว</span><span class="pp-peek-hint">${canPeek ? 'แตะเพื่อจัดการ' : 'แตะเพื่อลบ'}</span></div>
 ${seenTag ? `<div class="pp-msg-meta"><span>${esc(seenTag)}</span></div>` : ''}
 </div></div>`;
 }

 const rh = replyHeaderHTML(m.replyTo);
 let inner = '', extra = '';
 if (m.type === 'image') {
 extra = ' pp-bubble-img';
 inner = `<div class="pp-img-msg" data-mediaidx="${idx}"><img class="pp-img-thumb" alt="รูป"></div>${m.caption ? `<div class="pp-img-cap">${esc(m.caption)}</div>` : ''}`;
 } else if (m.type === 'sticker') {
 extra = ' pp-bubble-sticker';
 inner = `<img class="pp-sticker-img" src="${esc(m.url || '')}" alt="${esc(m.label || 'สติกเกอร์')}" onerror="this.style.opacity='.3'">`;
 } else if (m.type === 'voice') {
 extra = ' pp-bubble-voice';
 inner = `<div class="pp-voice" data-voiceidx="${idx}"><span class="pp-voice-play">${ICON.play}</span>
 <span class="pp-voice-wave"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></span>
 <span class="pp-voice-dur">${esc(fmtDur(m.dur))}</span></div>
 ${m.text ? `<div class="pp-voice-text">${esc(m.text)}</div>` : ''}`;
 } else if (m.type === 'location') {
 inner = `<div class="pp-loc"><span class="pp-loc-map">${ICON.pin2}</span><span>
 <span class="pp-loc-name">${esc(m.place || '')}</span>${m.note ? `<span class="pp-loc-note">${esc(m.note)}</span>` : ''}</span></div>`;
 } else if (m.type === 'contactcard') {
 const cc = findContact(m.cardId);
 inner = `<div class="pp-contactcard">${contactAvatarHTML(cc || { name: m.cardName || '?' }, 40)}
 <span class="pp-contactcard-meta"><span class="pp-contactcard-name">${esc(cc ? dname(cc) : (m.cardName || '?'))}</span>
 <span class="pp-contactcard-sub">การ์ดคอนแทกต์</span></span></div>`;
 } else if (m.type === 'poll') {
 inner = pollHTML(m, idx);
 } else if (m.type === 'gift') {
 inner = `<div class="pp-loc"><span class="pp-loc-map" style="background:linear-gradient(150deg,#ff9f0a,#ff375f)">${ICON.gift}</span>
 <span><span class="pp-loc-name">${esc(m.giftName || 'ของขวัญ')}</span>
 ${m.amount ? `<span class="pp-loc-note">${esc(fmtMoney(m.amount))}</span>` : ''}</span></div>`;
 } else if (m.type === 'sharedpost') {
 extra = ' pp-bubble-shared';
 inner = sharedPostCardHTML(m, idx);
 } else {
 inner = esc(m.text);
 }

 let senderTag = '', avatarCol = '';
 if (groupMode && !out) {
 const sc = findContact(m.sender);
 if (!grouped) senderTag = `<div class="pp-grp-sender">${esc(m.senderName || (sc ? dname(sc) : '?'))}</div>`;
 avatarCol = tail
 ? `<span class="pp-grp-msg-av">${sc ? contactAvatarHTML(sc, 28) : avHTML('', (m.senderName || '?')[0], 28)}</span>`
 : `<span class="pp-grp-msg-av empty"></span>`;
 }
 // ★ meta: เวลา + ดาว + แก้ไข + สถานะอ่าน/ส่ง (เฉพาะข้อความล่าสุดของผู้ใช้)
 const th = getThread(tid);
 const star = isStarred(tid, m.mid);
 const bits = [];
 if (tail && m.ts) bits.push(`<span>${esc(fmtHM(new Date(m.ts)))}</span>`);
 if (star) bits.push(ICON.star);
 if (m.edited) bits.push('<span>แก้ไขแล้ว</span>');
 if (out) {
 const lastUser = th.filter(x => x.from === 'me' && !x.unsent).slice(-1)[0];
 if (lastUser === m) {
 const replied = th.slice(idx + 1).some(x => x.from === 'them' && !x.unsent);
 bits.push(`<span>${replied ? 'อ่านแล้ว' : 'ส่งแล้ว'}</span>`);
 }
 }
 const meta = bits.length ? `<div class="pp-msg-meta">${bits.join(' ')}</div>` : '';
 const sel = ppSelectMode ? `<span class="pp-ms-check${ppSelected.has(m.mid) ? ' on' : ''}" data-selmid="${esc(m.mid || '')}" style="margin:0 8px">${ppSelected.has(m.mid) ? ICON.check : ''}</span>` : '';

 return `<div class="pp-brow ${out ? 'out' : 'in'}${grouped ? ' grp' : ''}${groupMode && !out ? ' grpmode' : ''}" data-mid="${esc(m.mid || '')}">
 ${sel}${avatarCol}
 <div class="pp-brow-col">${senderTag}
 <div class="pp-bubble${tail ? ' tail' : ''}${extra}" data-msgidx="${idx}">${rh}${inner}</div>
 ${meta}
 </div>
 </div>`;
}

function renderThread() {
 const isGroup = !!ppActiveGroup;
 const c = ppActiveContact, g = ppActiveGroup;
 if (!isGroup && !c) { ppNav('messages'); return; }
 const tid = isGroup ? g.id : c.id;

 const nameEl = document.getElementById('pp-chat-hdr-name');
 if (nameEl) nameEl.textContent = threadName(tid);
 const avSlot = document.getElementById('pp-chat-hdr-av');
 if (avSlot) avSlot.innerHTML = threadAvatarHTML(tid, 30);
 const callBtn = document.getElementById('pp-chat-call-btn');
 if (callBtn) callBtn.style.display = isGroup ? 'none' : 'flex';

 // แถบดาว
 const sb = document.getElementById('pp-star-banner');
 const sbt = document.getElementById('pp-star-banner-txt');
 const stars = starredMsgs(tid);
 if (sb) {
 if (stars.length) {
 sb.style.display = 'flex';
 const last = stars[stars.length - 1];
 if (sbt) sbt.textContent = `${stars.length} ข้อความติดดาว · ${String(last.text || msgPreview(last)).slice(0, 40)}`;
 } else sb.style.display = 'none';
 }

 const msgs = document.getElementById('pp-msgs');
 if (!msgs) return;
 const th = getThread(tid);
 const filtered = ppChatFilter ? th.filter(m => String(m.text || m.caption || '').toLowerCase().includes(ppChatFilter.toLowerCase())) : th;

 if (!filtered.length) {
 msgs.innerHTML = `<div class="pp-sys">${ppChatFilter ? 'ไม่พบข้อความที่ค้นหา' : (isGroup ? 'เริ่มคุยในกลุ่ม แล้วกดปุ่มให้สมาชิกตอบ' : 'เริ่มบทสนทนา แตะฟองเพื่อจัดการ ปัดขวาเพื่อตอบ')}</div>`;
 } else {
 const total = filtered.length;
 const startIdx = ppChatFilter ? 0 : Math.max(0, total - ppHistShown);
 let html = '';
 if (startIdx > 0) html += `<div class="pp-loadmore"><button class="pp-regen" id="pp-loadmore-btn">ดูข้อความเก่ากว่านี้ (${startIdx})</button></div>`;
 let prevTs = null, first = true;
 filtered.forEach((m, fi) => {
 if (fi < startIdx) return;
 const realIdx = ppChatFilter ? th.indexOf(m) : fi;
 const div = first ? chatDividerFull(m.ts || 0) : chatDivider(prevTs, m.ts || 0);
 first = false;
 if (div) html += `<div class="pp-time-divider">${esc(div)}</div>`;
 prevTs = m.ts || prevTs;
 const special = m.type === 'call' || m.type === 'transfer' || m.from === 'sys' || m.type === 'nickname' || m.type === 'sysline';
 if (special) { html += browHTML(m, realIdx, false, true, isGroup, tid); return; }
 const prev = fi - 1 >= startIdx ? filtered[fi - 1] : null;
 const next = filtered[fi + 1];
 const key = x => x ? (x.from === 'me' ? 'me' : (isGroup ? (x.sender || 'them') : 'them')) : null;
 const isSpec = x => x && (x.type === 'call' || x.type === 'transfer' || x.from === 'sys' || x.type === 'nickname' || x.type === 'sysline');
 const noGrpPrev = isSpec(prev);
 const noGrpNext = isSpec(next);
 const grouped = prev && key(prev) === key(m) && !noGrpPrev && !m.replyTo && !div && !m.edited && !isStarred(tid, m.mid);
 const tail = !next || key(next) !== key(m) || noGrpNext;
 html += browHTML(m, realIdx, grouped, tail, isGroup, tid);
 });
 if (ppGeneratingId !== tid && !isGroup && !ppChatFilter) {
 const last = th[th.length - 1];
 if (last && last.from === 'them' && last.type !== 'call' && last.type !== 'transfer') {
 html += `<div class="pp-regen-row"><button class="pp-regen" id="pp-regen-btn">${ICON.regen}รีเจน</button></div>`;
 }
 }
 msgs.innerHTML = html;
 }
 applyChatStyle();
 hydrateThreadImages();
 restoreDraft(tid);
 if (ppGeneratingId === tid) showTyping();
 if (!ppChatFilter) msgs.scrollTop = msgs.scrollHeight;
}
function hydrateThreadImages() {
 const tid = ppActiveGroup ? ppActiveGroup.id : (ppActiveContact ? ppActiveContact.id : null);
 if (!tid) return;
 const th = getThread(tid);
 document.querySelectorAll('#pp-msgs .pp-img-msg[data-mediaidx]').forEach(el => {
 const m = th[+el.dataset.mediaidx];
 if (m && m.mediaKey) loadMedia(m.mediaKey).then(img => { const im = el.querySelector('img'); if (im && img) im.src = img; });
 });
 document.querySelectorAll('#pp-msgs .pp-shared-img[data-sharedimg]').forEach(el => {
 const p = findPost(el.dataset.sharedimg);
 if (p && p.mediaKeys && p.mediaKeys[0]) loadMedia(p.mediaKeys[0]).then(img => { if (img) el.style.backgroundImage = `url(${img})`; });
 });
}
async function applyChatStyle() {
 const tid = ppActiveGroup ? ppActiveGroup.id : (ppActiveContact ? ppActiveContact.id : null);
 if (!tid) return;
 const st = getChatStyle(tid);
 const scr = document.getElementById('pp-scr-chat');
 const msgs = document.getElementById('pp-msgs');
 if (msgs) {
 if (st.bg === 'custom') {
 const img = await loadMedia('chatbg-' + tid);
 if (img) { msgs.style.background = '#000 center/cover no-repeat'; msgs.style.backgroundImage = `url(${img})`; }
 else { msgs.style.backgroundImage = ''; msgs.style.background = ''; }
 } else { msgs.style.backgroundImage = ''; msgs.style.background = st.bg ? (CHAT_BGS[st.bg] || '') : ''; }
 msgs.style.backdropFilter = st.msgBlur ? `blur(${st.msgBlur}px)` : '';
 }
 if (scr) {
 scr.style.setProperty('--pp-mybub', st.bubble || getCfg().accent || '#0a84ff');
 scr.style.setProperty('--pp-mytext', st.textColor || '#ffffff');
 scr.classList.toggle('bub-glass', !!st.bubbleGlass);
 scr.setAttribute('data-tail', st.tail || 'round');
 if (st.bubbleImg) {
 const img = await loadMedia('bubbleimg-' + tid);
 if (img) { scr.style.setProperty('--pp-bubimg', `url(${img})`); scr.classList.add('has-bubimg'); } else scr.classList.remove('has-bubimg');
 } else scr.classList.remove('has-bubimg');
 }
}
function showTyping(label) {
 const msgs = document.getElementById('pp-msgs');
 if (!msgs || document.getElementById('pp-typing')) return;
 msgs.querySelector('.pp-regen-row')?.remove();
 msgs.insertAdjacentHTML('beforeend', `<div class="pp-brow in" id="pp-typing">${label
 ? `<div class="pp-brow-col"><div class="pp-grp-sender">${esc(label)}</div><div class="pp-typing"><span></span><span></span><span></span></div></div>`
 : `<div class="pp-typing"><span></span><span></span><span></span></div>`}</div>`);
 msgs.scrollTop = msgs.scrollHeight;
}
function hideTyping() { document.getElementById('pp-typing')?.remove(); }
function ppWarpTo(mid) {
 const el = document.querySelector(`#pp-msgs .pp-brow[data-mid="${CSS.escape(mid)}"]`);
 if (!el) { ppToast('หาข้อความต้นทางไม่เจอ ลองกด "ดูข้อความเก่ากว่านี้"'); return; }
 el.scrollIntoView({ behavior: 'smooth', block: 'center' });
 el.classList.add('pp-warp-hl');
 setTimeout(() => el.classList.remove('pp-warp-hl'), 1600);
}

// ══════════════════════════════════════════════════════════
// message actions
// ══════════════════════════════════════════════════════════
function curTid() { return ppActiveGroup ? ppActiveGroup.id : (ppActiveContact ? ppActiveContact.id : null); }
function ppMsgActions(idx) {
 const tid = curTid(); if (!tid) return;
 const m = getThread(tid)[idx];
 if (!m) return;
 if (ppSelectMode) { toggleSelect(m.mid); return; }
 const items = [];

 // ★ 1.4.1 ข้อความที่ยกเลิกแล้ว — ยังต้องส่อง แก้ไข และลบทิ้งได้
 if (m.unsent) {
  const mine = m.from === 'me';
  const canPeek = mine || (m.letUserPeek !== false && getCfg().unsendPeekEnabled !== false);
  if (canPeek) {
   items.push({ label: 'ส่องเนื้อหาที่ถูกยกเลิก', icon: ICON.eye, onClick: () => {
    const note = mine
     ? (m.seenBeforeUnsend ? 'คุณยกเลิกช้าไป อีกฝ่ายอ่านข้อความนี้ไปแล้ว' : 'คุณยกเลิกทัน อีกฝ่ายยังไม่ได้อ่านเนื้อหานี้')
     : 'อีกฝ่ายยกเลิกข้อความนี้ แต่คุณแอบเห็นได้';
    ppAlert(mine ? 'ข้อความที่คุณยกเลิก' : 'ข้อความที่ถูกยกเลิก',
     `<div class="pp-quote"><div class="pp-quote-txt">${esc(m.origText || '(ไม่มีเนื้อหา)')}</div></div>
      <div class="pp-hint" style="margin:8px 0 0">${esc(note)}</div>`);
   } });
  }
  if (mine) {
   items.push({ label: 'ยกเลิกการยกเลิก (ส่งกลับ)', icon: ICON.regen, onClick: () => {
    m.unsent = false;
    m.text = m.origText || m.text || '';
    delete m.origText; delete m.unsentAt; delete m.seenBeforeUnsend; delete m.letUserPeek;
    m.edited = true;
    saveCfg();
    ppLog(isGroupId(tid) ? 'group' : 'chat', `ส่งข้อความที่ยกเลิกไว้กลับให้ ${threadLabel(tid)}: "${String(m.text).slice(0, 80)}"`);
    renderThread(); renderContactList();
    ppToast('ส่งกลับแล้ว');
   } });
   items.push({ label: 'แก้ไขเนื้อหาแล้วส่งใหม่', icon: ICON.compose, onClick: () => {
    ppPrompt('แก้ไขแล้วส่งใหม่', m.origText || '', v => {
     if (!v) return;
     const before = m.origText || '';
     m.unsent = false;
     m.text = v;
     delete m.origText; delete m.unsentAt; delete m.seenBeforeUnsend; delete m.letUserPeek;
     m.edited = true;
     saveCfg();
     ppLog(isGroupId(tid) ? 'group' : 'chat', `แก้ไขข้อความที่ยกเลิกไว้แล้วส่งใหม่ให้ ${threadLabel(tid)}`,
      [`เดิม: "${String(before).slice(0, 70)}"`, `ใหม่: "${v}"`]);
     renderThread(); renderContactList();
     ppToast('ส่งใหม่แล้ว');
    }, { rows: 3 });
   } });
  }
  items.push({ label: 'ลบทิ้งถาวร (ไม่เหลือแถบเทา)', icon: ICON.trash, danger: true, onClick: () => {
   ppConfirm('ลบทิ้งถาวร', 'ลบข้อความนี้ออกจากห้องเลย จะไม่เหลือแถบ "ยกเลิกข้อความแล้ว" ให้เห็นอีก', () => ppDeleteMsg(idx), 'ลบ');
  } });
  ppSheet('ข้อความที่ยกเลิกแล้ว', items);
  return;
 }

 if (m.type !== 'call' && m.type !== 'transfer') {
 if (m.mid) items.push({ label: 'ตอบข้อความนี้', icon: ICON.reply, onClick: () => ppReplyToMsg(idx) });
 // ★ 1.4.0 ยกเลิกข้อความของตัวเอง (ต่างจากลบ — ยังเห็นแถบเทา บอทอาจอ่านทันหรือไม่ทัน)
 if (m.from === 'me' && !m.unsent) items.push({ label: 'ยกเลิกข้อความ', icon: ICON.ban, onClick: () => ppUnsendMyMsg(idx) });
 if (m.mid) items.push({ label: isStarred(tid, m.mid) ? 'เอาดาวออก' : 'ติดดาว', icon: isStarred(tid, m.mid) ? ICON.starOut : ICON.star, onClick: () => { const on = toggleStar(tid, m.mid); renderThread(); ppToast(on ? 'ติดดาวแล้ว' : 'เอาดาวออกแล้ว'); } });
 if (m.from === 'me' && (m.type === undefined || m.type === 'image' || m.type === 'voice')) {
 items.push({ label: m.type === 'image' ? 'แก้ไขคำบรรยาย' : m.type === 'voice' ? 'แก้ไขคำพูด' : 'แก้ไขข้อความ', icon: ICON.compose, onClick: () => ppEditMsg(idx) });
 }
 items.push({ label: 'แชร์ไปหาบอทอื่น', icon: ICON.share, onClick: () => ppShareMsgToBot(idx) });
 items.push({ label: 'เลือกหลายข้อความ', icon: ICON.check, onClick: () => enterSelectMode(m.mid) });
 }
 items.push({ label: 'ลบ', icon: ICON.trash, danger: true, onClick: () => ppDeleteMsg(idx) });
 ppSheet(null, items);
}
function ppReplyToMsg(idx) {
 const tid = curTid(); if (!tid) return;
 const m = getThread(tid)[idx];
 if (!m || !m.mid) return;
 const author = m.from === 'me' ? getUserDisplayName() : (m.senderName || threadName(tid));
 const quoted = m.type === 'image' ? (m.caption || '[รูป]') : m.type === 'transfer' ? ('โอนเงิน ' + fmtMoney(m.amount)) : (m.text || msgPreview(m));
 ppReplyComposer({
 title: 'ตอบข้อความ', quotedLabel: author, quoted,
 onOk: text => {
 pushThreadMsg(tid, { from: 'me', text, replyTo: { kind: 'msg', text: quoted, author, targetMid: m.mid } });
 ppLog(isGroupId(tid) ? 'group' : 'chat', `ตอบข้อความของ ${author} ใน ${threadLabel(tid)}`, [`อ้างถึง: "${String(quoted).slice(0, 60)}"`, `ตอบว่า: "${text}"`]);
 renderThread(); renderContactList();
 }
 });
}
function ppEditMsg(idx) {
 const tid = curTid(); if (!tid) return;
 const m = getThread(tid)[idx];
 if (!m) return;
 const cur = m.type === 'image' ? (m.caption || '') : (m.text || '');
 const title = m.type === 'image' ? 'แก้ไขคำบรรยายรูป' : m.type === 'voice' ? 'แก้ไขคำพูด' : 'แก้ไขข้อความ';
 ppPrompt(title, cur, v => {
 const before = cur;
 if (m.type === 'image') m.caption = v; else m.text = v;
 m.edited = true;
 saveCfg();
 ppLog(isGroupId(tid) ? 'group' : 'chat', `แก้ไขข้อความใน ${threadLabel(tid)}`, [`จาก: "${String(before).slice(0, 60)}"`, `เป็น: "${v}"`]);
 renderThread(); renderContactList();
 ppToast('แก้ไขแล้ว');
 });
}
/** ★ 1.4.0 ยกเลิกข้อความของเราเอง — ไม่ใช่ลบ ข้อความยังอยู่เป็นแถบเทา
 * บอทอาจอ่านทันหรือไม่ทัน ขึ้นกับว่าเราปล่อยไว้นานแค่ไหน */
function ppUnsendMyMsg(idx) {
 const tid = curTid();
 if (!tid) return;
 const th = getThread(tid);
 const m = th[idx];
 if (!m || m.from !== 'me' || m.unsent) return;
 const age = Date.now() - (m.ts || Date.now());
 // ยกเลิกเร็ว = โอกาสบอทอ่านทันต่ำ · ปล่อยไว้นาน = โอกาสอ่านทันสูง
 let chance;
 if (age < 15000) chance = 0.12;
 else if (age < 45000) chance = 0.35;
 else if (age < 180000) chance = 0.65;
 else chance = 0.9;
 // ถ้ามีข้อความบอทตอบหลังจากนี้แล้ว = อ่านทันแน่นอน
 const repliedAfter = th.slice(idx + 1).some(x => x.from === 'them' && !x.unsent);
 const seen = repliedAfter || Math.random() < chance;
 const original = m.text || m.caption || msgPreview(m);
 m.unsent = true;
 m.origText = original;
 m.letUserPeek = true;
 m.unsentAt = Date.now();
 m.seenBeforeUnsend = seen;
 saveCfg();
 const who = threadLabel(tid);
 ppLog(isGroupId(tid) ? 'group' : 'chat',
  seen ? `ยกเลิกข้อความที่ส่งให้ ${who} แต่ ${who} อ่านทันแล้ว`
       : `ยกเลิกข้อความที่ส่งให้ ${who} ก่อนที่ ${who} จะอ่านทัน`,
  [seen ? `ข้อความที่ ${who} อ่านไปแล้ว: "${String(original).slice(0, 120)}"`
        : `เนื้อหาที่ถูกยกเลิก (${who} ไม่ได้เห็น): "${String(original).slice(0, 120)}"`]);
 renderThread();
 renderContactList();
 ppToast(seen ? `ยกเลิกแล้ว แต่ ${who} อ่านทันไปก่อน` : `ยกเลิกทัน ${who} ยังไม่ได้อ่าน`);
}
function ppDeleteMsg(idx) {
 const tid = curTid(); if (!tid) return;
 const th = getThread(tid);
 if (idx < 0 || idx >= th.length) return;
 const m = th[idx];
 if (m && m.mediaKey) delMedia(m.mediaKey);
 if (m && m.mid) { const arr = getStarred(tid); const i = arr.indexOf(m.mid); if (i >= 0) arr.splice(i, 1); }
 th.splice(idx, 1);
 saveCfg();
 ppLog(isGroupId(tid) ? 'group' : 'chat', `ลบข้อความใน ${threadLabel(tid)}: "${String(msgLogText(m)).slice(0, 70)}"`);
 renderThread(); renderContactList();
}
function ppShareMsgToBot(idx) {
 const tid = curTid(); if (!tid) return;
 const m = getThread(tid)[idx];
 if (!m) return;
 const srcName = m.from === 'me' ? getUserDisplayName() : (m.senderName || threadName(tid));
 const quoted = m.type === 'image' ? (m.caption || '[รูป]') : (m.text || msgPreview(m));
 ppPickContact('แชร์ไปหาใคร', cid => {
 pushThreadMsg(cid, { from: 'me', text: `(แชร์จาก ${srcName}) ${quoted}` });
 ppLog('chat', `แชร์ข้อความของ ${srcName} ไปให้ ${cname(cid)}`, [`เนื้อหา: "${String(quoted).slice(0, 80)}"`]);
 ppActiveContact = findContact(cid); ppActiveGroup = null; ppNav('chat');
 ppToast('แชร์แล้ว');
 }, tid);
}
function enterSelectMode(mid) {
 ppSelectMode = true; ppSelected.clear();
 if (mid) ppSelected.add(mid);
 renderThread();
 ppToast('แตะข้อความเพื่อเลือก');
 showSelectBar();
}
function toggleSelect(mid) {
 if (!mid) return;
 if (ppSelected.has(mid)) ppSelected.delete(mid); else ppSelected.add(mid);
 // อัปเดตเฉพาะเช็คบ็อกซ์ กัน re-render ทั้งห้อง (ไม่ดีดลงล่าง)
 const chk = document.querySelector(`#pp-msgs .pp-brow[data-mid="${CSS.escape(mid)}"] .pp-ms-check`);
 if (chk) { chk.classList.toggle('on', ppSelected.has(mid)); chk.innerHTML = ppSelected.has(mid) ? ICON.check : ''; }
 showSelectBar();
}
function showSelectBar() {
 document.getElementById('pp-selbar')?.remove();
 if (!ppSelectMode) return;
 const scr = document.getElementById('pp-scr-chat');
 if (!scr) return;
 const bar = document.createElement('div');
 bar.id = 'pp-selbar';
 bar.className = 'pp-inputbar';
 bar.innerHTML = `<span style="flex:1;font-size:14px;color:var(--pp-txt2);padding-left:6px">เลือก ${ppSelected.size} ข้อความ</span>
 <button class="pp-btn" id="pp-sel-cancel">ยกเลิก</button>
 <button class="pp-btn" id="pp-sel-share">${ICON.share}ส่งต่อ</button>
 <button class="pp-btn danger" id="pp-sel-del">${ICON.trash}ลบ</button>`;
 scr.appendChild(bar);
 bar.querySelector('#pp-sel-cancel').addEventListener('click', () => { ppSelectMode = false; ppSelected.clear(); bar.remove(); renderThread(); });
 bar.querySelector('#pp-sel-share').addEventListener('click', () => {
 const tid = curTid();
 const msgs = getThread(tid).filter(m => ppSelected.has(m.mid));
 if (!msgs.length) { ppToast('ยังไม่ได้เลือก'); return; }
 ppPickContact('ส่งต่อไปหาใคร', cid => {
 msgs.forEach(m => pushThreadMsg(cid, { from: 'me', text: `(ส่งต่อ) ${m.text || msgPreview(m)}` }));
 ppLog('chat', `ส่งต่อ ${msgs.length} ข้อความจาก ${threadLabel(tid)} ไปให้ ${cname(cid)}`,
 msgs.slice(0, 6).map(m => `- "${String(m.text || msgPreview(m)).slice(0, 60)}"`));
 ppSelectMode = false; ppSelected.clear(); bar.remove();
 ppActiveContact = findContact(cid); ppActiveGroup = null; ppNav('chat');
 ppToast('ส่งต่อแล้ว');
 }, tid);
 });
 bar.querySelector('#pp-sel-del').addEventListener('click', () => {
 const tid = curTid();
 const n = ppSelected.size;
 if (!n) { ppToast('ยังไม่ได้เลือก'); return; }
 ppConfirm('ลบข้อความ', `ลบ ${n} ข้อความที่เลือก?`, () => {
 const arr = getThread(tid); // อ้างอิง array ของรูทจริง (ผ่าน threadKey)
 const kept = arr.filter(m => {
 if (!ppSelected.has(m.mid)) return true;
 if (m.mediaKey) delMedia(m.mediaKey);
 return false;
 });
 arr.length = 0;
 Array.prototype.push.apply(arr, kept);
 saveCfg();
 ppLog(isGroupId(tid) ? 'group' : 'chat', `ลบ ${n} ข้อความใน ${threadLabel(tid)}`);
 ppSelectMode = false; ppSelected.clear(); bar.remove();
 renderThread(); renderContactList();
 }, 'ลบ');
 });
}
function renderStarredScreen() {
 const tid = curTid();
 const body = document.getElementById('pp-starred-body');
 if (!body || !tid) return;
 const arr = starredMsgs(tid);
 if (!arr.length) { body.innerHTML = `<div class="pp-empty">${ICON.starOut}<br>ยังไม่มีข้อความติดดาว<span>เปิด action sheet ที่ฟองข้อความเพื่อติดดาว</span></div>`; return; }
 const th = getThread(tid);
 body.innerHTML = arr.map(m => {
 const idx = th.indexOf(m);
 return browHTML(m, idx, false, true, isGroupId(tid), tid);
 }).join('');
 hydrateThreadImages();
}

// ══════════════════════════════════════════════════════════
// send / attach / sticker / draft
// ══════════════════════════════════════════════════════════
function saveDraft(tid, v) {
 const cfg = getCfg();
 const key = threadKey(tid);
 if (v) cfg.drafts[key] = v; else delete cfg.drafts[key];
 saveCfg();
}
function restoreDraft(tid) {
 const input = document.getElementById('pp-input');
 if (!input) return;
 const d = (getCfg().drafts || {})[threadKey(tid)] || '';
 input.value = d;
 input.style.height = 'auto';
 if (d) input.style.height = Math.min(120, input.scrollHeight) + 'px';
}
function ppSendUserMessage() {
 const tid = curTid();
 if (!tid) return false;
 const input = document.getElementById('pp-input');
 const text = (input.value || '').trim();
 if (!text) return false;
 input.value = ''; input.style.height = 'auto';
 saveDraft(tid, '');
 pushThreadMsg(tid, { from: 'me', text });
 ppLog(isGroupId(tid) ? 'group' : 'chat', `ส่งข้อความให้ ${threadLabel(tid)}: "${text}"`);
 renderThread(); renderContactList();
 return true;
}
function ppAttachMenu() {
 const tid = curTid();
 const items = [
 { label: 'ส่งรูป', icon: ICON.image, onClick: () => document.getElementById('pp-chat-img-file')?.click() },
 { label: 'ส่งตำแหน่ง', icon: ICON.pin2, onClick: ppSendLocation },
 { label: 'ส่งการ์ดคอนแทกต์', icon: ICON.card, onClick: ppSendContactCard },
 { label: 'ส่งข้อความเสียง', icon: ICON.mic, onClick: ppSendVoice },
 ];
 if (isGroupId(tid)) items.push({ label: 'สร้างโพล', icon: ICON.poll, onClick: ppCreatePoll });
 if (!isGroupId(tid) && tid) {
 items.push({ label: 'โอนเงิน', icon: ICON.transfer, onClick: () => ppTransferComposer(tid) });
 items.push({ label: 'ส่งของขวัญ', icon: ICON.gift, onClick: () => ppSendGift(tid) });
 }
 items.push({ label: 'ตั้งเวลาส่งข้อความ', icon: ICON.clock, onClick: ppScheduleMsg });
 ppSheet('แนบ', items);
}
async function ppHandleChatImage(file) {
 const tid = curTid();
 if (!tid || !file) return;
 const dataUrl = await ppReadImageFile(file);
 if (!dataUrl) { ppToast('อ่านไฟล์รูปไม่ได้'); return; }
 const mediaKey = 'chatimg-' + tid + '-' + newId();
 const ok = await saveMedia(mediaKey, dataUrl);
 if (!ok) { ppToast('บันทึกรูปไม่สำเร็จ (พื้นที่เก็บข้อมูลอาจเต็ม) ลองรูปที่เล็กลง'); return; }
 const finish = caption => {
 pushThreadMsg(tid, { from: 'me', type: 'image', mediaKey, caption: caption || '' });
 ppLog(isGroupId(tid) ? 'group' : 'chat', `ส่งรูปให้ ${threadLabel(tid)}`,
 [caption ? `คำบรรยายรูป: "${caption}"` : 'ไม่ได้ใส่คำบรรยายรูป']);
 renderThread(); renderContactList();
 };
 const mode = getCfg().imageCaptionMode || 'ask';
 const aiPath = async () => {
 islandStatus('กำลังอ่านภาพ…');
 const cap = await captionImageAI(dataUrl);
 islandCollapse();
 if (cap) finish(cap);
 else ppPrompt('อ่านภาพไม่ได้ พิมพ์คำบรรยายเอง', '', v => finish(v), { hint: 'บอทมองรูปไม่เห็นตรง ๆ ต้องมีคำบรรยาย' });
 };
 if (mode === 'ai') return aiPath();
 if (mode === 'self') return ppPrompt('ในภาพมีอะไร', '', v => finish(v));
 ppSheet('คำบรรยายรูป', [
 { label: 'ให้ AI อ่านภาพให้', icon: ICON.generate, onClick: aiPath },
 { label: 'พิมพ์คำบรรยายเอง', icon: ICON.compose, onClick: () => ppPrompt('ในภาพมีอะไร', '', v => finish(v)) },
 { label: 'ส่งโดยไม่มีคำบรรยาย', icon: ICON.image, onClick: () => finish('') },
 ]);
}
function ppSendLocation() {
 const tid = curTid(); if (!tid) return;
 ppPrompt('ชื่อสถานที่', '', place => {
 if (!place) return;
 ppPrompt('โน้ตเพิ่มเติม (ไม่บังคับ)', '', note => {
 pushThreadMsg(tid, { from: 'me', type: 'location', place, note });
 ppLog(isGroupId(tid) ? 'group' : 'chat', `ส่งตำแหน่ง "${place}" ให้ ${threadLabel(tid)}${note ? ` (โน้ต: ${note})` : ''}`);
 renderThread(); renderContactList();
 }, { rows: 2 });
 }, { rows: 1, placeholder: 'เช่น ร้านกาแฟหน้าปากซอย' });
}
function ppSendContactCard() {
 const tid = curTid(); if (!tid) return;
 ppPickContact('ส่งการ์ดของใคร', cid => {
 pushThreadMsg(tid, { from: 'me', type: 'contactcard', cardId: cid, cardName: cname(cid) });
 ppLog(isGroupId(tid) ? 'group' : 'chat', `ส่งการ์ดคอนแทกต์ของ ${cname(cid)} ให้ ${threadLabel(tid)}`);
 renderThread(); renderContactList();
 }, tid);
}
function ppSendVoice() {
 const tid = curTid(); if (!tid) return;
 ppPrompt('พิมพ์คำพูดที่จะส่งเป็นเสียง', '', v => {
 if (!v) return;
 pushThreadMsg(tid, { from: 'me', type: 'voice', text: v, dur: Math.min(60, Math.max(2, Math.round(v.length / 8))) });
 ppLog(isGroupId(tid) ? 'group' : 'chat', `ส่งข้อความเสียงให้ ${threadLabel(tid)} ว่า "${v}"`);
 renderThread(); renderContactList();
 });
}
function ppCreatePoll() {
 const tid = curTid(); if (!tid) return;
 ppPrompt('คำถามโพล', '', q => {
 if (!q) return;
 ppPrompt('ตัวเลือก (บรรทัดละข้อ)', '', raw => {
 const opts = String(raw || '').split('\n').map(s => s.trim()).filter(Boolean).slice(0, 8);
 if (opts.length < 2) { ppToast('ต้องมีอย่างน้อย 2 ตัวเลือก'); return; }
 pushThreadMsg(tid, { from: 'me', type: 'poll', question: q, options: opts.map(t => ({ text: t, votes: [] })) });
 ppLog('group', `สร้างโพลในกลุ่ม ${threadName(tid)}: "${q}"`, opts.map(o => `- ${o}`));
 renderThread(); renderContactList();
 }, { rows: 4, placeholder: 'ตัวเลือก 1\nตัวเลือก 2' });
 }, { rows: 2 });
}
function ppVotePoll(idx, oi) {
 const tid = curTid(); if (!tid) return;
 const m = getThread(tid)[idx];
 if (!m || m.type !== 'poll') return;
 (m.options || []).forEach(o => { o.votes = (o.votes || []).filter(v => v !== 'user'); });
 const opt = m.options[oi];
 if (!opt) return;
 opt.votes = opt.votes || [];
 opt.votes.push('user');
 saveCfg();
 ppLog('group', `โหวตโพล "${m.question}" ในกลุ่ม ${threadName(tid)} เลือก "${opt.text}"`);
 renderThread();
}
function ppSendGift(tid) {
 ppPrompt('ชื่อของขวัญ', '', name => {
 if (!name) return;
 ppPrompt('มูลค่า (ไม่บังคับ · หักจากกระเป๋าเงิน)', '', amtRaw => {
 const amt = Math.abs(parseInt(String(amtRaw).replace(/[^\d]/g, ''), 10) || 0);
 if (amt) {
 if ((getCfg().walletBalance || 0) < amt) { ppToast('ยอดเงินไม่พอ'); return; }
 adjustUserBalance(-amt);
 pushWalletHistory('out', amt, tid, cname(tid), `ของขวัญ: ${name}`);
 }
 pushThreadMsg(tid, { from: 'me', type: 'gift', giftName: name, amount: amt });
 ppLog('chat', `ส่งของขวัญ "${name}" ให้ ${cname(tid)}${amt ? ` มูลค่า ${fmtMoney(amt)}` : ''}`);
 renderThread(); renderContactList(); updateHomeWidgets();
 }, { rows: 1 });
 }, { rows: 1, placeholder: 'เช่น ช่อดอกไม้' });
}
function ppScheduleMsg() {
 const tid = curTid(); if (!tid) return;
 ppPrompt('ข้อความที่จะส่งครั้งถัดไป', (getCfg().scheduled || {})[tid] || '', v => {
 const cfg = getCfg();
 if (v) { cfg.scheduled[tid] = v; ppToast('จะส่งตอนกดเจนครั้งถัดไป'); }
 else { delete cfg.scheduled[tid]; ppToast('ยกเลิกข้อความตั้งเวลาแล้ว'); }
 saveCfg();
 }, { hint: 'ข้อความจะถูกส่งอัตโนมัติก่อนบอทตอบครั้งถัดไป' });
}
function renderStickerTray() {
 const packs = getStickerPacks();
 const pk = document.getElementById('pp-sticker-packs');
 const gr = document.getElementById('pp-sticker-grid');
 if (!pk || !gr) return;
 if (!packs.length) {
 pk.innerHTML = '';
 gr.innerHTML = `<div class="pp-empty" style="grid-column:1/-1;padding:26px 16px">${ICON.sticker}<br>ยังไม่มีสติกเกอร์<span>เพิ่มได้ที่ ตั้งค่า › สติกเกอร์</span></div>`;
 return;
 }
 if (!ppStickerPackActive || !findStickerPack(ppStickerPackActive)) ppStickerPackActive = packs[0].id;
 pk.innerHTML = packs.map(p => `<button data-spack="${esc(p.id)}"${p.id === ppStickerPackActive ? ' class="on"' : ''}>${esc(p.name)}</button>`).join('');
 const pack = findStickerPack(ppStickerPackActive);
 const items = (pack && pack.items) || [];
 gr.innerHTML = items.length
 ? items.map((it, i) => `<button class="pp-sticker-cell" data-sticker="${esc(ppStickerPackActive)}:${i}"><img src="${esc(it.url)}" alt="${esc(it.label || '')}" onerror="this.style.opacity='.25'"></button>`).join('')
 : `<div class="pp-empty" style="grid-column:1/-1;padding:22px">ชุดนี้ยังไม่มีสติกเกอร์</div>`;
}
function ppSendSticker(packId, i) {
 const tid = curTid(); if (!tid) return;
 const pack = findStickerPack(packId);
 const it = pack && (pack.items || [])[i];
 if (!it) return;
 pushThreadMsg(tid, { from: 'me', type: 'sticker', url: it.url, label: it.label || '' });
 ppLog(isGroupId(tid) ? 'group' : 'chat', `ส่งสติกเกอร์${it.label ? ` "${it.label}"` : ''} ให้ ${threadLabel(tid)}`);
 document.getElementById('pp-sticker-tray')?.classList.remove('show');
 renderThread(); renderContactList();
}
function ppPlayVoice(idx) {
 const tid = curTid(); if (!tid) return;
 const m = getThread(tid)[idx];
 if (!m || m.type !== 'voice') return;
 const scr = document.getElementById('pp-scr-chat');
 if (!scr) return;
 document.getElementById('pp-voice-ov')?.remove();
 const ov = document.createElement('div');
 ov.id = 'pp-voice-ov';
 ov.innerHTML = `<div class="pp-voice-ov-box">
  <div class="pp-voice-ov-inner"></div>
  <div class="pp-voice-ov-full">${esc(m.text || '')}</div>
 </div>
 <button class="pp-voice-ov-close">${ICON.close}</button>`;
 scr.appendChild(ov);
 const inner = ov.querySelector('.pp-voice-ov-inner');
 ov.querySelector('.pp-voice-ov-close').addEventListener('click', () => ov.remove());
 // ★ 1.4.4 แตะที่ไหนก็หยุด/เล่นต่อ — อ่านไม่ทันก็ค้างไว้อ่านได้
 let paused = false;
 ov.addEventListener('click', e => {
  if (e.target.closest('.pp-voice-ov-close')) return;
  paused = !paused;
  ov.classList.toggle('paused', paused);
  if (!paused) step();
 });
 requestAnimationFrame(() => ov.classList.add('show'));
 const words = String(m.text || '').split(/\s+/).filter(Boolean);
 let i = 0;
 const step = () => {
  if (!document.getElementById('pp-voice-ov')) return;
  if (paused) return;
  if (i >= words.length) {
   // ★ 1.4.4 ค้างไว้ให้อ่านนานขึ้น ก่อนจางหาย
   setTimeout(() => { if (document.getElementById('pp-voice-ov')) ov.classList.remove('show'); }, 3200);
   setTimeout(() => ov.remove(), 3800);
   return;
  }
  const sp = document.createElement('span');
  sp.textContent = words[i] + ' ';
  inner.appendChild(sp);
  requestAnimationFrame(() => sp.classList.add('show'));
  i++;
  // ★ 1.4.4 จาก 240ms เป็น 420ms + ถ่วงตามความยาวคำ
  const wordLen = (words[i - 1] || '').length;
  setTimeout(step, 420 + Math.min(400, wordLen * 22) + Math.random() * 120);
 };
 step();
}

// ══════════════════════════════════════════════════════════
// transfer accept/decline
// ══════════════════════════════════════════════════════════
function ppTransferComposer(cid) {
 const c = findContact(cid);
 if (!c) return;
 const cfg = getCfg();
 const ov = ppOverlay('bottom', `<div class="pp-sheet">
 <div class="pp-sheet-grab"></div>
 <div class="pp-sheet-head">
 <span class="pp-sheet-title">โอนให้ ${esc(dname(c))}</span>
 <span style="font-size:12px;color:var(--pp-txt3)">ยอด ${esc(fmtMoney(cfg.walletBalance))}</span>
 </div>
 <div class="pp-sheet-body" style="padding:0 18px 14px">
 <input class="pp-input-line pp-t-amt" inputmode="numeric" placeholder="จำนวนเงิน" style="font-size:24px;font-weight:700;text-align:center;margin-bottom:10px">
 <input class="pp-input-line pp-t-note" placeholder="โน้ต (ไม่บังคับ)" style="margin-bottom:14px">
 <div class="pp-dlg-row" style="margin:0">
 <button class="pp-btn pp-no">ยกเลิก</button>
 <button class="pp-btn primary pp-yes">โอนเลย</button>
 </div>
 </div>
 </div>`);
 const amtEl = ov.querySelector('.pp-t-amt');
 const noteEl = ov.querySelector('.pp-t-note');
 setTimeout(() => amtEl?.focus(), 60);
 ov.querySelector('.pp-no').addEventListener('click', () => ov.remove());
 ov.querySelector('.pp-yes').addEventListener('click', () => {
 const amount = Math.abs(parseInt(String(amtEl.value).replace(/[^\d]/g, ''), 10) || 0);
 const note = (noteEl.value || '').trim();
 if (!amount) { ppToast('ใส่จำนวนเงิน'); return; }
 if ((getCfg().walletBalance || 0) < amount) { ppToast('ยอดเงินไม่พอ'); return; }
 const lim = getCfg().walletDailyLimit || 0;
 if (lim && spentToday() + amount > lim) { ppToast(`เกินลิมิตต่อวัน (${fmtMoney(lim)})`); return; }
 adjustUserBalance(-amount);
 setBotWallet(cid, getBotWallet(cid) + amount);
 pushWalletHistory('out', amount, cid, dname(c), note);
 pushThreadMsg(cid, { from: 'me', type: 'transfer', amount, note, status: 'accepted' });
 ppLog('wallet', `โอนเงิน ${fmtMoney(amount)} ให้ ${dname(c)}${note ? ` โน้ตว่า "${note}"` : ''}`, [`ยอดคงเหลือ ${fmtMoney(getCfg().walletBalance)}`]);
 ov.remove();
 ppActiveContact = c; ppActiveGroup = null;
 if (ppCurrentScreen !== 'chat') ppNav('chat'); else renderThread();
 renderContactList(); updateHomeWidgets();
 ppToast(`โอน ${fmtMoney(amount)} แล้ว`);
 });
}
function ppAcceptTransfer(idx) {
 const c = ppActiveContact; if (!c) return;
 const m = getThread(c.id)[idx];
 if (!m || m.type !== 'transfer' || m.from !== 'them') return;
 if (m.status && m.status !== 'pending') return;
 m.status = 'accepted';
 adjustUserBalance(m.amount);
 setBotWallet(c.id, getBotWallet(c.id) - m.amount);
 pushWalletHistory('in', m.amount, c.id, dname(c), m.note);
 saveCfg();
 ppLog('wallet', `รับเงิน ${fmtMoney(m.amount)} จาก ${dname(c)}${m.note ? ` (โน้ต: ${m.note})` : ''}`, [`ยอดคงเหลือ ${fmtMoney(getCfg().walletBalance)}`]);
 renderThread(); renderContactList(); updateHomeWidgets();
 ppToast(`รับ ${fmtMoney(m.amount)} แล้ว`);
}
function ppDeclineTransfer(idx) {
 const c = ppActiveContact; if (!c) return;
 const m = getThread(c.id)[idx];
 if (!m || m.type !== 'transfer' || m.from !== 'them') return;
 if (m.status && m.status !== 'pending') return;
 m.status = 'declined';
 saveCfg();
 ppLog('wallet', `ปฏิเสธเงิน ${fmtMoney(m.amount)} จาก ${dname(c)}`);
 renderThread();
 ppToast('ปฏิเสธการโอนแล้ว');
}

// ══════════════════════════════════════════════════════════
// chat menus / settings
// ══════════════════════════════════════════════════════════
function ppChatMenu() {
 const tid = curTid(); if (!tid) return;
 const isGroup = isGroupId(tid);
 const items = [
 { label: isGroup ? 'ตั้งค่ากลุ่ม' : 'ตั้งค่าแชท', icon: ICON.gear, onClick: () => ppNav(isGroup ? 'groupsettings' : 'chatsettings') },
 { label: 'ข้อความติดดาว', icon: ICON.star, onClick: () => ppNav('starred') },
 { label: 'ค้นหาในห้องนี้', icon: ICON.search, onClick: () => {
 const w = document.getElementById('pp-chat-search-wrap');
 if (w) { const show = w.style.display === 'none'; w.style.display = show ? 'block' : 'none'; if (show) document.getElementById('pp-chat-search')?.focus(); else { ppChatFilter = ''; renderThread(); } }
 } },
 { label: isPinned(tid) ? 'เลิกปักหมุด' : 'ปักหมุดแชท', icon: ICON.pin, onClick: () => ppTogglePin(tid) },
 { label: isMuted(tid) ? 'เปิดเสียงแจ้งเตือน' : 'ปิดเสียงแจ้งเตือน', icon: isMuted(tid) ? ICON.bell : ICON.bellOff, onClick: () => ppToggleMute(tid) },
 { label: isArchived(tid) ? 'เอาออกจากคลัง' : 'เก็บเข้าคลัง', icon: ICON.archive, onClick: () => { ppToggleArchive(tid); ppNav('messages'); } },
 ];
 if (!isGroup) items.push({ label: 'ประวัติการโทรกับคนนี้', icon: ICON.phoneApp, onClick: () => { ppCallLogFilter = tid; ppCallLogEdit = false; ppNav('calllog'); } });
 items.push({ label: 'ล้างประวัติแชท', icon: ICON.trash, danger: true, onClick: () => {
 ppConfirm('ล้างประวัติแชท', `ลบข้อความทั้งหมดกับ ${threadName(tid)}? คอนแทกต์ยังอยู่`, () => {
 const arr = getThread(tid); // รูทจริงผ่าน threadKey
 arr.forEach(m => { if (m.mediaKey) delMedia(m.mediaKey); });
 arr.length = 0;
 const stars = getStarred(tid); // starred ของรูทจริงผ่าน threadKey (B1)
 stars.length = 0;
 saveCfg();
 ppLog('chat', `ล้างประวัติแชทกับ ${threadName(tid)}`);
 renderThread(); renderContactList();
 ppToast('ล้างแล้ว');
 }, 'ล้าง');
 } });
 if (!isGroup && tid === currentCharacterId()) {
 items.unshift({ label: 'สลับรูท (แชท SillyTavern)', icon: ICON.messages, onClick: ppOpenRouteSwitcher });
 }
 // ผูก NPC เข้ากับตัวละครหลัก (ให้โฟกัสถูกกลุ่ม)
 if (!isGroup) {
 const _c = findContact(tid);
 if (_c && _c.npc) {
 const cur = _c.baseCharId || _c.ownerCharId || '';
 items.unshift({ label: cur ? `ผูกกับ: ${cname(cur)} · แตะเปลี่ยน` : 'ผูก NPC นี้กับตัวละคร', icon: ICON.users, onClick: () => {
 const chars = listStCharacters();
 const opts = [{ label: 'ไม่ผูกใคร', icon: ICON.person, onClick: () => { _c.ownerCharId = ''; _c.baseCharId = ''; saveCfg(); renderContactList(); ppToast('เอาการผูกออกแล้ว'); } }];
 chars.forEach(ch => opts.push({ label: ch.name + (cur === ch.id ? ' ·' : ''), icon: ICON.users, onClick: () => { _c.ownerCharId = ch.id; saveCfg(); renderContactList(); ppToast(`ผูกกับ ${ch.name} แล้ว`); } }));
 ppSheet('ผูก NPC นี้กับตัวละครไหน', opts);
 } });
 }
 }
 // ผูก Lorebook กับ NPC
 if (!isGroup) {
 const _lc = findContact(tid);
 if (_lc && _lc.npc) {
 items.unshift({ label: _lc.loreBook ? `Lorebook: ${_lc.loreBook}` : 'ผูก Lorebook', icon: ICON.compass, onClick: () => ppPickLorebook(tid) });
 }
 }
 ppSheet(threadName(tid), items);
}
function ppMsgListMenu() {
 ppSheet('ข้อความ', [
 { label: 'คลังเก็บ', icon: ICON.archive, onClick: () => ppNav('archive') },
 { label: 'จัดการสติกเกอร์', icon: ICON.sticker, onClick: () => ppNav('stickers') },
 { label: 'อ่านทั้งหมดแล้ว', icon: ICON.check, onClick: () => { const cfg = getCfg(); cfg.unread = {}; saveCfg(); renderContactList(); updateHomeWidgets(); ppToast('ทำเครื่องหมายอ่านแล้ว'); } },
 ]);
}
function renderChatSettings() {
 const c = ppActiveContact;
 const body = document.getElementById('pp-chatsettings-body');
 if (!c || !body) { ppNav('messages'); return; }
 const st = getChatStyle(c.id);
 const cfg = getCfg();
 const personas = listUserPersonas();
 const bgSwatches = Object.keys(CHAT_BGS).map(k =>
 `<button class="pp-swatch${st.bg === k ? ' on' : ''}" data-chatbg="${k}" style="background:${k ? CHAT_BGS[k] : 'var(--pp-fill2)'}">${k ? '' : 'ปกติ'}</button>`).join('')
 + `<button class="pp-swatch${st.bg === 'custom' ? ' on' : ''}" data-chatbg="custom" style="background:var(--pp-fill2)">รูป</button>`;
 const packs = getStickerPacks();

 body.innerHTML = `
 <div style="display:flex;flex-direction:column;align-items:center;gap:8px;padding:8px 0 14px">
 ${contactAvatarHTML(c, 78)}
 <div style="font-size:18px;font-weight:700">${esc(dname(c))}</div>
 </div>

 <div class="pp-sec-label">ชื่อที่แสดง (แค่ในมือถือ)</div>
 <div class="pp-btn-row" style="margin:0">
 <input class="pp-input-line" id="pp-rename-input" placeholder="ชื่อ" value="${esc(c.customName || '')}" style="flex:1">
 <button class="pp-btn" id="pp-rename-save">บันทึก</button>
 </div>

 <div class="pp-sec-label">Persona ตัวละคร (แค่ในมือถือ ไม่แตะ SillyTavern)</div>
 <input class="pp-input-line" id="pp-persona-name" placeholder="ชื่อตัวละคร (เว้นว่าง = ใช้ของ ST)" value="${esc(st.personaName || '')}" style="margin-bottom:6px">
 <textarea class="pp-input-line" id="pp-persona-desc" rows="3" placeholder="คำอธิบายบุคลิก (เว้นว่าง = ใช้ของ ST)">${esc(st.personaDesc || '')}</textarea>
 <button class="pp-btn" id="pp-persona-save" style="margin-top:6px">บันทึก Persona</button>

 <div class="pp-sec-label">Persona ของฉันที่บอทคนนี้อ่าน</div>
 ${cfg.userPersonaMode === 'shared'
 ? `<div class="pp-hint">ตั้งเป็น "เหมือนกันทุกแชท" อยู่ — เปลี่ยนได้ที่ ตั้งค่า › Persona ของฉัน</div>`
 : `<button class="pp-persona-opt${!st.userPersonaId ? ' on' : ''}" data-userpersona=""><span class="pp-persona-opt-lb">ค่าเริ่มต้น (persona ปัจจุบันของ ST)</span>${!st.userPersonaId ? ICON.check : ''}</button>`
 + (personas.length
 ? personas.map(p => `<button class="pp-persona-opt${st.userPersonaId === p.id ? ' on' : ''}" data-userpersona="${esc(p.id)}">
 <img class="pp-persona-opt-av" src="${esc(p.avatar)}" onerror="this.style.visibility='hidden'">
 <span class="pp-persona-opt-lb">${esc(p.name)}</span>${st.userPersonaId === p.id ? ICON.check : ''}</button>`).join('')
 : `<div class="pp-hint">ไม่พบ persona ผู้ใช้ใน SillyTavern</div>`)}

 ${c.userNickname ? `<div class="pp-sec-label">ชื่อที่ ${esc(dname(c))} บันทึกคุณไว้</div>
 <div class="pp-card"><div class="pp-cell">
 <span class="pp-cell-lb">${ICON.compose} "${esc(c.userNickname)}"</span>
 <span class="pp-cell-val">${esc(fmtNoteAge(c.userNicknameAt))}</span></div></div>` : ''}

 <div class="pp-sec-label">อื่น ๆ</div>
 <div class="pp-card">
 <div class="pp-cell"><span class="pp-cell-lb">ทำเป็น NPC (หมวด NPC)</span>
 <label class="pp-switch"><input type="checkbox" id="pp-npc-toggle"${c.npc ? ' checked' : ''}><span></span></label></div>
 <div class="pp-cell"><span class="pp-cell-lb">ชุดสติกเกอร์ที่ใช้กับคนนี้</span>
 <select class="pp-sel" id="pp-cs-stickerpack">
 <option value="">ทุกชุด</option>
 ${packs.map(p => `<option value="${esc(p.id)}"${st.stickerPack === p.id ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}
 </select></div>
 <div class="pp-cell tap" data-nav="starred"><span class="pp-cell-lb">${ICON.star} ข้อความติดดาว</span>
 <span class="pp-cell-val">${starredMsgs(c.id).length}${ICON.chevron}</span></div>
 <div class="pp-cell tap" id="pp-calllog-btn"><span class="pp-cell-lb">${ICON.phoneApp} ประวัติการโทร</span>
 <span class="pp-cell-val">${ICON.chevron}</span></div>
 </div>

 <div class="pp-sec-label">เสียงเรียกเข้าของแชทนี้</div>
 <div class="pp-btn-row" style="margin:0">
 <input class="pp-input-line" id="pp-cs-ringtone" placeholder="ลิงก์เสียง (เว้นว่าง = ใช้ค่าเริ่มต้น)" value="${esc(st.ringtone || '')}" style="flex:1">
 <button class="pp-btn" id="pp-cs-ringtone-save">บันทึก</button>
 </div>

 <div class="pp-sec-label">พื้นหลังแชท</div>
 <div class="pp-swatches">${bgSwatches}</div>
 <label class="pp-upload">${ICON.upload} อัปโหลดรูปพื้นหลัง<input type="file" id="pp-chatbg-file" accept="image/*" hidden></label>

 <div class="pp-sec-label">ฟองข้อความของฉัน</div>
 <div class="pp-btn-row" style="margin:0 0 8px">
 <label class="pp-color-wrap"><input type="color" id="pp-bubble-color" value="${esc(st.bubble || cfg.accent || '#0a84ff')}"><span>พื้นฟอง</span></label>
 <label class="pp-color-wrap"><input type="color" id="pp-text-color" value="${esc(st.textColor || '#ffffff')}"><span>ตัวอักษร</span></label>
 </div>
 <div class="pp-card">
 <div class="pp-cell"><span class="pp-cell-lb">ฟองแบบกระจก</span>
 <label class="pp-switch"><input type="checkbox" id="pp-bubble-glass"${st.bubbleGlass ? ' checked' : ''}><span></span></label></div>
 <div class="pp-cell"><span class="pp-cell-lb">ทรงฟอง</span>
 <select class="pp-sel" id="pp-cs-tail">
 <option value="round"${st.tail === 'round' ? ' selected' : ''}>มน (มีหาง)</option>
 <option value="pill"${st.tail === 'pill' ? ' selected' : ''}>แคปซูล</option>
 <option value="sharp"${st.tail === 'sharp' ? ' selected' : ''}>เหลี่ยม</option>
 </select></div>
 <div class="pp-cell"><span class="pp-cell-lb">เบลอพื้นหลังข้อความ</span>
 <input type="range" id="pp-cs-msgblur" min="0" max="20" step="1" value="${st.msgBlur || 0}" style="flex:1;max-width:52%"></div>
 </div>
 <div class="pp-btn-row">
 <label class="pp-upload">${ICON.upload} ใช้รูปเป็นพื้นฟอง<input type="file" id="pp-bubbleimg-file" accept="image/*" hidden></label>
 <button class="pp-btn" id="pp-bubble-clear">ล้างรูปฟอง</button>
 </div>`;
}

// ══════════════════════════════════════════════════════════
// group editor
// ══════════════════════════════════════════════════════════
function renderGroupEditor() {
 const d = ppGroupDraft || (ppGroupDraft = { id: null, name: '', members: [], knowEachOther: true, cooldownSec: 0, replyMode: 'many', warnNote: '' });
 const t = document.getElementById('pp-groupnew-title'); if (t) t.textContent = d.id ? 'แก้ไขกลุ่ม' : 'สร้างกลุ่ม';
 const sb = document.getElementById('pp-group-save-btn'); if (sb) sb.textContent = d.id ? 'บันทึก' : 'สร้าง';
 const body = document.getElementById('pp-groupnew-body');
 if (!body) return;
 const chips = d.members.map(cid => {
 const c = findContact(cid);
 return c ? `<span class="pp-chip">${contactAvatarHTML(c, 24)}<span>${esc(dname(c))}</span></span>` : '';
 }).join('') || `<span class="pp-hint" style="margin:4px">ยังไม่ได้เลือกสมาชิก</span>`;
 body.innerHTML = `
 <div class="pp-sec-label">ชื่อกลุ่ม</div>
 <input class="pp-input-line" id="pp-group-name" placeholder="ตั้งชื่อกลุ่ม" value="${esc(d.name || '')}">
 <div class="pp-sec-label">สมาชิก</div>
 <button class="pp-btn wide" id="pp-group-members-btn" style="text-align:left">เลือกสมาชิก…</button>
 <div class="pp-chips">${chips}</div>
 <div class="pp-sec-label">การตอบโต้</div>
 <div class="pp-card">
 <div class="pp-cell"><span class="pp-cell-lb">สมาชิกรู้จักกัน (คุยโต้กันได้)</span>
 <label class="pp-switch"><input type="checkbox" id="pp-group-know"${d.knowEachOther ? ' checked' : ''}><span></span></label></div>
 <div class="pp-cell"><span class="pp-cell-lb">โหมดตอบต่อการเจน</span>
 <select class="pp-sel" id="pp-group-replymode">
 <option value="many"${d.replyMode === 'many' ? ' selected' : ''}>หลายคน</option>
 <option value="one"${d.replyMode === 'one' ? ' selected' : ''}>ทีละคน</option>
 </select></div>
 <div class="pp-cell"><span class="pp-cell-lb">คูลดาวน์ระหว่างเจน (วินาที)</span>
 <input class="pp-num" type="number" id="pp-group-cooldown" min="0" max="600" value="${d.cooldownSec || 0}"></div>
 </div>
 <div class="pp-sec-label">โน้ต/กติกาของกลุ่ม (ป้อนให้บอทรู้)</div>
 <textarea class="pp-input-line" id="pp-group-warn" rows="3" placeholder="เช่น กติกากลุ่ม โทน หัวข้อที่ห้ามพูด">${esc(d.warnNote || '')}</textarea>`;
}
function ppGroupSave() {
 const d = ppGroupDraft;
 if (!d) return;
 d.name = (document.getElementById('pp-group-name')?.value || '').trim();
 d.knowEachOther = !!document.getElementById('pp-group-know')?.checked;
 d.replyMode = document.getElementById('pp-group-replymode')?.value || 'many';
 d.cooldownSec = Math.max(0, Math.min(600, parseInt(document.getElementById('pp-group-cooldown')?.value || '0', 10) || 0));
 d.warnNote = (document.getElementById('pp-group-warn')?.value || '').trim();
 if (!d.name) { ppToast('ตั้งชื่อกลุ่มก่อน'); return; }
 if ((d.members || []).length < 2) { ppToast('เลือกสมาชิกอย่างน้อย 2 คน'); return; }
 const cfg = getCfg();
 if (d.id) {
 const g = cfg.groups.find(x => x.id === d.id);
 if (g) Object.assign(g, d);
 ppLog('group', `แก้ไขการตั้งค่ากลุ่ม "${d.name}"`);
 ppToast('บันทึกกลุ่มแล้ว');
 } else {
 d.id = 'grp:' + newId();
 cfg.groups.push(structuredClone(d));
 ppLog('group', `สร้างกลุ่ม "${d.name}" กับ ${d.members.map(cname).join(', ')}`);
 ppToast('สร้างกลุ่มแล้ว');
 }
 saveCfg();
 ppGroupDraft = null;
 ppNav('messages');
}
function renderGroupSettings() {
 const g = ppActiveGroup;
 const body = document.getElementById('pp-groupsettings-body');
 if (!g || !body) { ppNav('messages'); return; }
 const st = getChatStyle(g.id);
 body.innerHTML = `
 <div style="display:flex;flex-direction:column;align-items:center;gap:8px;padding:8px 0 14px">
 ${groupAvatarHTML(g, 78)}
 <div style="font-size:18px;font-weight:700">${esc(g.name)}</div>
 </div>
 <button class="pp-btn wide" id="pp-group-edit-btn">แก้ไขการตั้งค่ากลุ่ม</button>
 <div class="pp-sec-label">สมาชิก (${(g.members || []).length})</div>
 <div class="pp-card">${groupMemberContacts(g).map(c => `<div class="pp-cell"><span class="pp-cell-lb">${contactAvatarHTML(c, 32)} ${esc(dname(c))}</span></div>`).join('')}</div>
 <div class="pp-sec-label">สรุปการตั้งค่า</div>
 <div class="pp-card">
 <div class="pp-cell"><span class="pp-cell-lb">สมาชิกรู้จักกัน</span><span class="pp-cell-val">${g.knowEachOther ? 'ใช่' : 'ไม่'}</span></div>
 <div class="pp-cell"><span class="pp-cell-lb">โหมดตอบ</span><span class="pp-cell-val">${g.replyMode === 'one' ? 'ทีละคน' : 'หลายคน'}</span></div>
 <div class="pp-cell"><span class="pp-cell-lb">คูลดาวน์</span><span class="pp-cell-val">${g.cooldownSec || 0} วิ</span></div>
 <div class="pp-cell tap" data-nav="starred"><span class="pp-cell-lb">${ICON.star} ข้อความติดดาว</span>
 <span class="pp-cell-val">${starredMsgs(g.id).length}${ICON.chevron}</span></div>
 </div>
 ${g.warnNote ? `<div class="pp-sec-label">โน้ตกลุ่ม</div><div class="pp-card"><div class="pp-cell" style="white-space:normal">${esc(g.warnNote)}</div></div>` : ''}
 <div class="pp-sec-label">พื้นหลังแชท</div>
 <div class="pp-swatches">${Object.keys(CHAT_BGS).map(k =>
 `<button class="pp-swatch${st.bg === k ? ' on' : ''}" data-chatbg="${k}" style="background:${k ? CHAT_BGS[k] : 'var(--pp-fill2)'}">${k ? '' : 'ปกติ'}</button>`).join('')
 + `<button class="pp-swatch${st.bg === 'custom' ? ' on' : ''}" data-chatbg="custom" style="background:var(--pp-fill2)">รูป</button>`}</div>
 <label class="pp-upload">${ICON.upload} อัปโหลดรูปพื้นหลัง<input type="file" id="pp-chatbg-file" accept="image/*" hidden></label>`;
 body.querySelector('#pp-group-edit-btn')?.addEventListener('click', () => { ppGroupDraft = structuredClone(g); ppNav('groupnew'); });
}
function ppDeleteGroup() {
 const g = ppActiveGroup;
 if (!g) return;
 ppConfirm('ลบกลุ่มนี้', `ลบกลุ่ม "${g.name}" และข้อความทั้งหมด?`, () => {
 const cfg = getCfg();
 cfg.groups = cfg.groups.filter(x => x.id !== g.id);
 delete cfg.threads[g.id]; delete cfg.chatStyle[g.id]; delete cfg.starred[g.id];
 delete cfg.unread[g.id]; delete cfg.drafts[g.id];
 saveCfg();
 ppLog('group', `ลบกลุ่ม "${g.name}"`);
 ppActiveGroup = null;
 ppNav('messages');
 ppToast('ลบกลุ่มแล้ว');
 }, 'ลบ');
}

// ══════════════════════════════════════════════════════════
// swipe-to-reply
// ══════════════════════════════════════════════════════════
function bindSwipeReply(msgs) {
 let x0 = 0, y0 = 0, target = null, active = false;
 msgs.addEventListener('touchstart', e => {
 const brow = e.target.closest('.pp-brow[data-mid]');
 if (!brow) { target = null; return; }
 target = brow; active = false;
 x0 = e.touches[0].clientX; y0 = e.touches[0].clientY;
 }, { passive: true });
 msgs.addEventListener('touchmove', e => {
 if (!target) return;
 const dx = e.touches[0].clientX - x0, dy = e.touches[0].clientY - y0;
 if (!active && Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy) * 1.4) active = true;
 if (active) {
 target.style.transform = `translateX(${Math.max(0, Math.min(64, dx))}px)`;
 target.style.transition = 'none';
 }
 }, { passive: true });
 msgs.addEventListener('touchend', e => {
 if (!target) return;
 const brow = target, dx = e.changedTouches[0].clientX - x0;
 brow.style.transition = '';
 brow.style.transform = '';
 if (active && dx > 46) {
 const bubble = brow.querySelector('[data-msgidx]');
 if (bubble) ppReplyToMsg(+bubble.dataset.msgidx);
 }
 target = null; active = false;
 }, { passive: true });
}

// ══════════════════════════════════════════════════════════
// CALL SYSTEM
// ══════════════════════════════════════════════════════════
function ppRingUrl(c) {
 const cfg = getCfg();
 const per = c ? (getChatStyle(c.id).ringtone || '') : '';
 return (per && per.trim()) || (cfg.ringtoneUrl || '');
}
function ppPlayRingtone(c) {
 const url = ppRingUrl(c);
 const a = document.getElementById('pp-ringtone-audio');
 if (!a || !url) return;
 try { a.src = url; a.loop = true; a.currentTime = 0; const p = a.play(); if (p && p.catch) p.catch(() => {}); } catch {}
}
function ppStopRingtone() {
 const a = document.getElementById('pp-ringtone-audio');
 if (a) { try { a.pause(); a.removeAttribute('src'); a.load(); } catch {} }
}
function setCallBg(bgId, c) {
 const bg = document.getElementById(bgId);
 if (!bg) return;
 const src = c && c.avatar;
 if (!src) { bg.classList.add('no-img'); bg.style.backgroundImage = ''; return; }
 const probe = new Image();
 probe.onload = () => { bg.classList.remove('no-img'); bg.style.backgroundImage = `url("${src}")`; };
 probe.onerror = () => { bg.classList.add('no-img'); bg.style.backgroundImage = ''; };
 probe.src = src;
}
function ppRenderCallScreen(c, status, ringing) {
 const scr = document.getElementById('pp-scr-call');
 if (!scr) return;
 scr.classList.toggle('ringing', !!ringing);
 const sub = document.getElementById('pp-call-sub'); if (sub) sub.textContent = ringing ? 'Pocket Phone Audio' : 'Pocket Phone';
 const nm = document.getElementById('pp-call-name'); if (nm) nm.textContent = dname(c);
 const st = document.getElementById('pp-call-status'); if (st) st.textContent = status;
 const dur = document.getElementById('pp-call-dur'); if (dur) dur.style.display = 'none';
 const av = document.getElementById('pp-call-av'); if (av) av.innerHTML = contactAvatarHTML(c, 116);
 setCallBg('pp-call-bg', c);
 const stage = document.getElementById('pp-call-stage'); if (stage) stage.innerHTML = '';
}
function ppStartCall() {
 const c = ppActiveContact;
 if (!c || ppCall || ppActiveGroup) return;
 ppCall = { c, incoming: false, connected: false, startTs: 0, timer: null, generating: false, transcript: [] };
 ppRenderCallScreen(c, 'กำลังโทร…', false);
 ppNav('call');
 ppPlayRingtone(c);
 setTimeout(() => { if (ppCall) ppConnectCall(); }, 1500 + Math.random() * 1200);
}
function ppIncomingCall(c) {
 if (!c || ppCall) return;
 ppCall = { c, incoming: true, connected: false, startTs: 0, timer: null, generating: false, transcript: [] };
 ppRenderCallScreen(c, 'สายเรียกเข้า', true);
 if (!document.getElementById('pp-dialog')?.open) { islandNotify(c, 'สายเรียกเข้า'); ppOpen(); }
 ppNav('call');
 islandTyping(c);
 ppPlayRingtone(c);
}
function ppConnectCall() {
 if (!ppCall) return;
 ppStopRingtone();
 ppCall.connected = true;
 ppCall.startTs = Date.now();
 islandCollapse();
 document.getElementById('pp-scr-call')?.classList.remove('ringing');
 const st = document.getElementById('pp-call-status'); if (st) st.textContent = 'เชื่อมต่อแล้ว';
 const dur = document.getElementById('pp-call-dur'); if (dur) dur.style.display = 'block';
 ppCall.timer = setInterval(() => {
 if (!ppCall || !ppCall.connected) return;
 const s = Math.floor((Date.now() - ppCall.startTs) / 1000);
 const d = document.getElementById('pp-call-dur');
 if (d) d.textContent = fmtDur(s);
 // ★ 1.3.0 ย่อสายอยู่ก็ยังเห็นเวลาบน island และแตะกลับเข้าสายได้
 if (ppCurrentScreen !== 'call' && document.getElementById('pp-dialog')?.open) ppCallIslandTick();
 }, 500);
 setTimeout(() => { const s2 = document.getElementById('pp-call-status'); if (s2 && ppCall) s2.textContent = ''; }, 2500);
 if (ppCall.incoming) setTimeout(() => ppCallGenerate(true), 600);
}
function ppAcceptCall() { if (ppCall && ppCall.incoming && !ppCall.connected) ppConnectCall(); }
function ppDeclineCall() { if (ppCall) { ppStopRingtone(); ppEndCall(true); } }
function ppCallEmit(text, who) {
 const stage = document.getElementById('pp-call-stage');
 if (!stage) return;
 const cfg = getCfg();
 const histMode = !!cfg.callHistoryOpen;
 const line = document.createElement('div');
 line.className = 'pp-call-line ' + (who === 'me' ? 'me' : 'them');
 line.textContent = text;
 stage.appendChild(line);
 requestAnimationFrame(() => line.classList.add('show'));
 if (histMode) {
  // โหมดบันทึกเต็ม: ไม่ลบ เก็บทุกบรรทัด เลื่อนอ่านย้อนได้
  while (stage.children.length > 400) stage.removeChild(stage.firstChild);
  stage.scrollTop = stage.scrollHeight;
  return;
 }
 while (stage.children.length > 4) stage.removeChild(stage.firstChild);
 stage.scrollTop = stage.scrollHeight;
 const life = Math.min(9000, 3200 + text.length * 90);
 line._ppFade = setTimeout(() => { line.classList.add('fade'); line._ppGone = setTimeout(() => line.remove(), 900); }, life);
}
/** ★ 1.3.0 ปุ่มสลับดูประวัติในสาย — กดเปิดเห็นทั้งหมด กดอีกทีกลับโหมดโฟกัส */
function ppToggleCallHistory() {
 const cfg = getCfg();
 cfg.callHistoryOpen = !cfg.callHistoryOpen;
 saveCfg();
 const btn = document.getElementById('pp-call-hist');
 if (btn) {
  btn.classList.toggle('on', cfg.callHistoryOpen);
  btn.title = cfg.callHistoryOpen ? 'ซ่อนประวัติ' : 'ดูประวัติสาย';
 }
 ppRepaintCallStage();
 ppToast(cfg.callHistoryOpen ? 'เปิดประวัติสาย เลื่อนขึ้นอ่านย้อนได้' : 'กลับโหมดโฟกัส');
}
/** วาด stage ใหม่จาก transcript จริง (ใช้ตอนสลับโหมด หรือกลับเข้าสาย) */
function ppRepaintCallStage() {
 const stage = document.getElementById('pp-call-stage');
 if (!stage || !ppCall) return;
 stage.querySelectorAll('.pp-call-line').forEach(el => { clearTimeout(el._ppFade); clearTimeout(el._ppGone); });
 stage.innerHTML = '';
 const histMode = !!getCfg().callHistoryOpen;
 const tr = ppCall.transcript || [];
 const src = histMode ? tr : tr.slice(-3);
 stage.classList.toggle('pp-call-hist-mode', histMode);
 src.forEach(m => {
  const line = document.createElement('div');
  line.className = 'pp-call-line ' + (m.from === 'me' ? 'me' : 'them') + ' show';
  line.textContent = m.text;
  stage.appendChild(line);
 });
 stage.scrollTop = stage.scrollHeight;
}
/** ★ 1.3.0 ย่อสายไปเล่นแอปอื่น — สายยังต่อ นาฬิกาเดินต่อ */
function ppMinimizeCall() {
 if (!ppCall) { ppNav('messages'); return; }
 ppNav('home');
 ppToast('สายยังต่ออยู่ · แตะแถบด้านบนเพื่อกลับเข้าสาย');
 ppCallIslandTick();
}
function ppCallIslandTick() {
 if (!ppCall || !ppCall.connected) return;
 const s = Math.floor((Date.now() - ppCall.startTs) / 1000);
 ppIslandState = { cid: ppCall.c.id, name: dname(ppCall.c), avatar: ppCall.c.avatar, kind: 'msg', text: `คุยสาย · ${fmtDur(s)}`, callLive: true };
 islandRefresh();
}
/** กลับเข้าหน้าสายจาก island */
function ppResumeCall() {
 if (!ppCall) return false;
 ppNav('call');
 ppRepaintCallStage();
 islandCollapse();
 return true;
}
function ppCallSend() {
 if (!ppCall || !ppCall.connected) return;
 if (ppCall.generating) { ppToast('อีกฝ่ายกําลังพูดอยู่ รอสักครู่'); return; }
 const inp = document.getElementById('pp-call-input');
 const t = (inp.value || '').trim();
 if (!t) return;
 inp.value = ''; inp.style.height = 'auto';
 ppCallEmit(t, 'me');
 ppCall.transcript.push({ from: 'me', text: t });
}
function ppEndCall(declined) {
 if (!ppCall) return;
 ppStopRingtone();
 const c = ppCall.c;
 const connected = ppCall.connected;
 const secs = connected ? Math.floor((Date.now() - ppCall.startTs) / 1000) : 0;
 if (ppCall.timer) clearInterval(ppCall.timer);
 const transcript = ppCall.transcript || [];
 const dir = ppCall.incoming ? 'in' : 'out';
 const missed = !connected;
 const cfg = getCfg();
 if (!cfg.callLog) cfg.callLog = [];
 const durText = connected ? fmtDur(secs) : (declined ? 'ปฏิเสธ' : 'ไม่ได้รับสาย');
 cfg.callLog.push({
 cid: c.id, name: dname(c), avatar: c.avatar, chatId: ppStChatId(),
 startISO: new Date().toISOString(), durText, incoming: ppCall.incoming, transcript,
 });
 pushThreadMsg(c.id, {
 from: dir === 'out' ? 'me' : 'them', type: 'call', dir, missed,
 text: connected ? `คุยกัน ${fmtDur(secs)}` : (declined ? 'ปฏิเสธสาย' : 'ไม่ได้รับสาย'),
 });

 // ★ Action Log — โทร พร้อม transcript
 const un = getUserDisplayName();
 const head = dir === 'out'
 ? (connected ? `โทรหา ${dname(c)} คุยกัน ${fmtDur(secs)}` : (declined ? `โทรหา ${dname(c)} แต่ถูกปฏิเสธ` : `โทรหา ${dname(c)} แต่ไม่มีคนรับ`))
 : (connected ? `รับสายจาก ${dname(c)} คุยกัน ${fmtDur(secs)}` : (declined ? `${dname(c)} โทรมา แต่ ${un} กดปฏิเสธ` : `${dname(c)} โทรมา แต่ ${un} ไม่ได้รับสาย`));
 const sub = transcript.length
 ? ['บทสนทนาในสาย:'].concat(transcript.slice(-12).map(t => `${t.from === 'me' ? un : dname(c)}: "${t.text}"`))
 : null;
 ppLog('call', head, sub);

 const av = document.getElementById('pp-callend-av'); if (av) av.innerHTML = contactAvatarHTML(c, 108);
 const nm = document.getElementById('pp-callend-name'); if (nm) nm.textContent = dname(c);
 const sb = document.getElementById('pp-callend-sub'); if (sb) sb.textContent = connected ? 'สายสิ้นสุด' : (declined ? 'ปฏิเสธสาย' : 'ไม่ได้รับสาย');
 const dd = document.getElementById('pp-callend-dur'); if (dd) dd.textContent = connected ? fmtDur(secs) : '';
 setCallBg('pp-callend-bg', c);
 ppCall = null;
 islandCollapse();
 ppNav('callend');
}
function renderCallLog() {
 const list = document.getElementById('pp-calllog-list');
 if (!list) return;
 const cfg = getCfg();
 let logs = (cfg.callLog || []).map((l, gi) => ({ ...l, gi }));
 if (ppCallLogFilter) {
 logs = logs.filter(l => l.cid === ppCallLogFilter);
 // กรองประวัติรายคน: ถ้าเป็นตัวละครหลัก ให้แยกตามรูท (แชท ST) ปัจจุบัน
 // สายเก่าที่ไม่มี chatId (ก่อนอัปเดต) ยังโชว์อยู่ทุกรูท เพื่อไม่ให้ข้อมูลเดิมหาย
 if (ppCallLogFilter === currentCharacterId()) {
 const curChat = ppStChatId();
 if (curChat) logs = logs.filter(l => !l.chatId || l.chatId === curChat);
 }
 }
 logs.reverse();
 const title = document.getElementById('pp-calllog-title');
 if (title) title.textContent = ppCallLogFilter ? `สายกับ ${logs[0] ? logs[0].name : cname(ppCallLogFilter)}` : 'โทรศัพท์';
 if (!logs.length) { list.innerHTML = `<div class="pp-empty">${ICON.phoneApp}<br>ยังไม่มีสาย</div>`; return; }
 list.innerHTML = logs.map(l => {
 const d = new Date(l.startISO);
 const when = `${fmtListTime(d.getTime())} · ${fmtHM(d)}`;
 return `<div class="pp-calllog-row" data-showtr="${l.gi}">
 ${avHTML(l.avatar, (l.name || '?')[0], 46)}
 <div class="pp-row-meta">
 <div class="pp-row-name">${l.incoming ? ICON.arrowIn : ICON.arrowOut} ${esc(l.name)}</div>
 <div class="pp-row-sub">${esc(when)}</div>
 </div>
 ${ppCallLogEdit
 ? `<button class="pp-btn danger" data-dellog="${l.gi}" style="padding:6px 11px">${ICON.trash}</button>`
 : `<span class="pp-row-time">${esc(l.durText)}</span>`}
 </div>`;
 }).join('');
}
function showTranscript(gi) {
 const l = (getCfg().callLog || [])[gi];
 if (!l) return;
 const body = document.getElementById('pp-transcript-body');
 const title = document.getElementById('pp-transcript-title');
 if (title) title.textContent = `สายกับ ${l.name} · ${l.durText}`;
 if (body) body.innerHTML = (l.transcript && l.transcript.length)
 ? l.transcript.map(m => `<div class="pp-brow ${m.from === 'me' ? 'out' : 'in'}"><div class="pp-brow-col"><div class="pp-bubble tail">${esc(m.text)}</div></div></div>`).join('')
 : `<div class="pp-sys">ไม่มีบทสนทนาในสายนี้</div>`;
 ppNav('transcript');
}
async function ppCallGenerate(opener) {
 if (!ppCall || !ppCall.connected || ppCall.generating) return;
 const c = ppCall.c;
 const inp = document.getElementById('pp-call-input');
 if (inp && inp.value.trim() && !opener) ppCallSend();
 ppCall.generating = true;
 islandStatus(`กําลังเจนคําตอบในสายกับ ${dname(c)}`);
 const ty = document.getElementById('pp-call-typing');
 if (ty) ty.classList.add('show');
 const callGenBtn = document.getElementById('pp-call-gen');
 if (callGenBtn) callGenBtn.disabled = true;
 try {
 const un = getUserDisplayName();
 // ตัวละครหลัก: การ์ด+persona ถูกโหลดโดย generateQuietPrompt แล้ว ไม่ฉีดซ้ำ (ประหยัดหลักหมื่นโทเคน)
 const persona = (c.id === currentCharacterId()) ? '' : getEffectivePersona(c.id);
 const up = getEffectiveUserPersona(c.id);
 const chatHist = getThread(c.id).slice(-HIST_LIMIT).map(m => {
 if (m.type === 'call') return `[${m.dir === 'out' ? 'โทรออก' : 'สายเข้า'}]`;
 if (m.type === 'transfer') return `[โอนเงิน ${fmtMoney(m.amount)}${m.note ? ' — ' + m.note : ''}]`;
 if (m.type === 'image') return `${m.from === 'me' ? un : dname(c)}: [ส่งรูป${m.caption ? ': ' + m.caption : ''}]`;
 if (m.type === 'voice') return `${m.from === 'me' ? un : dname(c)}: (เสียง) ${m.text}`;
 if (m.type === 'sticker') return `${m.from === 'me' ? un : dname(c)}: [สติกเกอร์${m.label ? ' ' + m.label : ''}]`;
 if (m.type === 'sharedpost') return `${m.from === 'me' ? un : dname(c)}: [แชร์โพสต์]`;
 const pre = m.replyTo ? `(ตอบ${m.replyTo.kind === 'story' ? 'สตอรี่' : m.replyTo.kind === 'msg' ? 'ข้อความ' : 'โน้ต'}: ${m.replyTo.text}) ` : '';
 return `${m.from === 'me' ? un : dname(c)}: ${pre}${m.text}`;
 }).join('\n');
 const note = getUserNote();
 const rp = '';
 const period = periodPromptNote(c.id);
 // flush ข้อความที่ผู้ใช้พิมพ์ค้างในช่อง ให้เข้า transcript ก่อน (กันตกหล่น)
 const _ci = document.getElementById('pp-call-input');
 if (_ci && _ci.value.trim() && !opener && !ppCall.generating) { ppCallEmit(_ci.value.trim(), 'me'); ppCall.transcript.push({ from: 'me', text: _ci.value.trim() }); _ci.value = ''; _ci.style.height = 'auto'; }
 const tr = (ppCall.transcript || []).slice(-20).map(m => `${m.from === 'me' ? un : dname(c)}: ${m.text}`).join('\n');
 const prompt = [
 `[Phone call — you are strictly ${dname(c)}, on a voice call with ${un}${opener ? ' that you just started' : ''}.]`,
 persona ? `You ARE this character. Stay fully in persona: ${persona}` : null,
 (up && (up.name || up.desc)) ? `Who you are talking to (${un}): ${[up.name ? 'Name: ' + up.name : '', up.desc].filter(Boolean).join(' — ')}` : null,
 rp ? `Ongoing roleplay context (stay consistent):\n${rp}` : null,
 period ? `Important — ${period}` : null,
 chatHist ? `Your recent text chat with ${un} (you remember this):\n${chatHist}` : null,
 note ? `${un}'s current status note: "${note.text}" (glance only, do not force a reaction).` : null,
 tr ? `\nThis call so far:\n${tr}` : null,
 opener ? `\nYou called ${un}. Open the call — say why you're calling, referencing what you two were just talking about if relevant.` : `\nContinue the call naturally.`,
 `\nSpeak as ${dname(c)} out loud. Break your speech into SHORT separate lines. Put EVERY spoken line inside double quotes " ".`,
 `Same language as ${un} (Thai). Output ONLY quoted spoken lines. No planning, no narration, no stage directions, no asterisks. Anything outside " " is discarded.`,
 `If your character is ready to end the call, say ONE short goodbye in a quoted line AND add a final line exactly: [HANGUP]. Do not keep saying goodbye across many turns without [HANGUP].`,
 ].filter(Boolean).join('\n');
 const raw = await genWithRetry(prompt, 3);
 const wantHangup = /\[HANGUP\]/i.test(raw);
 const lines = spokenOrFallback(raw, 5);
 if (!lines.length) lines.push('…');
 if (ty) ty.classList.remove('show');
 let bye = false;
 for (let i = 0; i < lines.length; i++) {
 if (!ppCall) break;
 ppCallEmit(lines[i], 'them');
 ppCall.transcript.push({ from: 'them', text: lines[i] });
 if (isFarewell(lines[i])) bye = true;
 await new Promise(r => setTimeout(r, 700 + Math.min(2600, lines[i].length * 55)));
 }
 if ((bye || wantHangup) && ppCall) { await new Promise(r => setTimeout(r, 1400)); if (ppCall) ppEndCall(); }
 } catch (e) {
 if (ty) ty.classList.remove('show');
 ppCallEmit('สายไม่ชัด ลองใหม่นะ', 'them');
 console.error('[pocket-phone] call gen', e);
 } finally {
 if (ppCall && ppCall.connected && ppCurrentScreen !== 'call') { /* island กลับไปโหมดคุยสาย */ }
 else islandCollapse();
 const cgb = document.getElementById('pp-call-gen');
 if (cgb) cgb.disabled = false;
 if (ppCall) ppCall.generating = false;
 }
}

window.PP_LOADED = 'parsed-3of4';
console.log(`[pocket-phone] ${PP_VERSION} ท่อน 3/4 พร้อม - แชท + โทร + Action Log ยิงครบ`);

// pocket-phone/index.js — 0.9.9 — ท่อน 3.5/4 (ฟีด 4 แท็บ + โปรไฟล์ + สตอรี่)
// ต่อจากท่อน 3/4 ที่จบตรง window.PP_LOADED = 'parsed-3of4'
// ⚠️ รันเดี่ยวไม่ได้ ต้องแปะครบ 4 ท่อน

// ══════════════════════════════════════════════════════════
// FEED — 4 แท็บ (หน้าแรก / สำรวจ / กิจกรรม / โปรไฟล์)
// ══════════════════════════════════════════════════════════
function feedByTab(kind) {
 const wantNews = kind === 'news';
 return getFeedPosts()
 .filter(p => (p.kind === 'news') === wantNews)
 .filter(p => !isPostArchived(p.id))
 .slice().sort((a, b) => (b.ts || 0) - (a.ts || 0));
}
function postFirstMedia(p) { return (p.mediaKeys && p.mediaKeys[0]) || p.mediaKey || null; }
function postMediaKeys(p) {
 if (p.mediaKeys && p.mediaKeys.length) return p.mediaKeys;
 return p.mediaKey ? [p.mediaKey] : [];
}
function postSharedTo(pid) {
 const out = [];
 const cfg = getCfg();
 Object.keys(cfg.threads || {}).forEach(tid => {
 (cfg.threads[tid] || []).forEach(m => {
 if (m.type === 'sharedpost' && m.postId === pid) out.push({ tid, mid: m.mid });
 });
 });
 return out;
}
// ══════════════════════════════════════════════════════════
// ★ 1.0.0 NEWS READER
// ══════════════════════════════════════════════════════════
let ppNewsGenBusy = false;
function newsPosts() {
 return getFeedPosts().filter(p => p.kind === 'news').slice().sort((a, b) => (b.ts || 0) - (a.ts || 0));
}
function renderNewsApp() {
 const list = document.getElementById('pp-newsapp-list');
 if (!list) return;
 const cfg = getCfg();
 const items = newsPosts();
 if (!items.length) {
  list.innerHTML = `<div class="pp-empty">${ICON.news}<br>ยังไม่มีข่าว<span>แตะปุ่มดาวมุมขวาบนเพื่อโหลดข่าวในโลกนี้</span></div>`;
  return;
 }
 list.innerHTML = items.map(p => {
  const seen = (cfg.newsSeen || {})[p.id];
  const lines = String(p.text || '').split('\n');
  const title = lines[0] || '(ไม่มีหัวข้อ)';
  return `<div class="pp-newsrow${seen ? '' : ' unseen'}" data-newsopen="${esc(p.id)}">
   <div class="pp-newsrow-meta">
    <div class="pp-newsrow-src">${esc(p.newsSource || p.authorName || 'ข่าว')}</div>
    <div class="pp-newsrow-title">${esc(title)}</div>
    <div class="pp-newsrow-foot">
     <span>${esc(fmtNoteAge(p.ts))}</span>
     <span>${ICON.comment.replace('<svg', '<svg style="width:11px;height:11px;vertical-align:-1px"')} ${(p.comments || []).length}</span>
     <span>${postTotalLikes(p)} ถูกใจ</span>
    </div>
   </div>
   <div class="pp-newsrow-thumb">${ICON.news}</div>
  </div>`;
 }).join('');
}
async function ppNewsGenerate() {
 if (ppNewsGenBusy || ppFeedGenBusy) return;
 ppNewsGenBusy = true; ppFeedGenAbort = false; ppGenAbort = false;
 const g = document.getElementById('pp-news-gen'); if (g) g.style.display = 'none';
 const s = document.getElementById('pp-news-stop'); if (s) s.style.display = 'flex';
 islandStatus('กำลังโหลดข่าว…');
 try {
  const cfg = getCfg();
  const rp = cfg.universeAffectsRP ? mainChatRecap(8) : '';
  const recent = newsPosts().slice(0, 3).map(p => `- ${String(p.text || '').split('\n')[0]}`).join('\n');
  const prompt = [
   `[In-world news app. Write ONE fresh news item from this world's media.]`,
   rp ? `World/story context:\n${rp}` : null,
   recent ? `Do NOT repeat these recent headlines:\n${recent}` : null,
   `Line 1 = headline. Line 2-3 = short body. Put EVERY line inside quotes " ".`,
   `Then a new line: [SOURCE] outlet name. Then a new line: [LIKES] N.`,
   `Thai. No emoji. No planning. No narration.`,
  ].filter(Boolean).join('\n');
  const raw = await genWithRetry(prompt, 2);
  if (ppFeedGenAbort) { ppToast('หยุดแล้ว'); return; }
  const text = spokenOrFallback(raw, 4).join('\n');
  if (!text) { ppToast('ยังไม่มีข่าวใหม่ ลองอีกครั้ง'); return; }
  const srcM = String(raw || '').match(/\[SOURCE\]\s*([^\n\]]{1,40})/i);
  const likesM = String(raw || '').match(/\[LIKES\]\s*(\d+)/i);
  const src = srcM ? stripEmoji(srcM[1].trim()) : 'ข่าวด่วน';
  cfg.feedPosts.push({
   id: newId(), author: 'news', kind: 'news', newsSource: src, authorName: src, handle: src,
   text: text.slice(0, 900), mediaKeys: [], captions: [], visibility: 'all',
   ts: Date.now(), likes: [], extraLikes: likesM ? parseInt(likesM[1], 10) : Math.floor(Math.random() * 300) + 40,
   comments: [], views: {}, saves: 0,
  });
  saveCfg();
  ppLog('feed', `อ่านข่าวใหม่จาก ${src}: "${String(text).split('\n')[0].slice(0, 70)}"`);
  renderNewsApp();
  ppToast('มีข่าวใหม่');
 } catch (e) { console.error('[pocket-phone] news gen', e); ppToast('สร้างข่าวไม่สำเร็จ: ' + ppGenerationError(e)); }
 finally {
  ppNewsGenBusy = false; ppFeedGenAbort = false; ppGenAbort = false; islandCollapse();
  const g2 = document.getElementById('pp-news-gen'); if (g2) g2.style.display = 'flex';
  const s2 = document.getElementById('pp-news-stop'); if (s2) s2.style.display = 'none';
 }
}

// ══════════════════════════════════════════════════════════
// ★ 1.0.0 helper แสดงผล : mention / heat / quote card / clout
// ══════════════════════════════════════════════════════════
function linkifyFeedText(raw) {
 return esc(raw)
  .replace(/#([^\s#.,!?]{1,30})/g, '<span class="pp-tag" data-tag="$1">#$1</span>')
  .replace(/@([^\s@#.,!?]{1,30})/g, '<span class="pp-mention" data-mention="$1">@$1</span>');
}
function heatBadge(p) {
 const h = p.heat || 0;
 if (!h) return '';
 return `<span class="pp-heat h${h}">${ICON.fire}${h >= 3 ? 'ดราม่าเดือด' : h === 2 ? 'มีคนเถียง' : 'แซะเบา ๆ'}</span>`;
}
function toneBadge(p) {
 if (!p.tone || p.author !== 'user') return '';
 const lb = p.tone === 'good' ? 'คนชอบ' : p.tone === 'bad' ? 'คนไม่ชอบ' : 'เฉย ๆ';
 return `<span class="pp-tone ${p.tone}">${lb}</span>`;
}
function quoteCardHTML(pid) {
 const src = findPost(pid);
 if (!src) return `<div class="pp-quote-card"><div class="pp-quote-card-gone">โพสต์ต้นทางถูกลบแล้ว</div></div>`;
 const av = src.author === 'user' ? ppUserAvatarCache : (findContact(src.author)?.avatar);
 const key = postFirstMedia(src);
 return `<div class="pp-quote-card" data-postopen="${esc(src.id)}">
  <div class="pp-quote-card-head">
   ${avHTML(av, postAuthorLabel(src)[0], 24)}
   <span class="pp-quote-card-name">${esc(postAuthorLabel(src))}</span>
   <span class="pp-quote-card-age">${esc(fmtNoteAge(src.ts))}</span>
  </div>
  ${src.text ? `<div class="pp-quote-card-text">${esc(String(src.text).slice(0, 160))}</div>` : ''}
  ${key ? `<div class="pp-quote-card-img" data-quoteimg="${esc(src.id)}"></div>` : ''}
 </div>`;
}
function cloutCardHTML() {
 const wk = cloudWeekDelta();
 const total = totalFollowerCount();
 return `<div class="pp-clout-card">
  <div class="pp-clout-top">${ICON.trend}<span>ชื่อเสียง</span></div>
  <div class="pp-clout-main">${total.toLocaleString('en-US')} <span style="font-size:14px;font-weight:600;opacity:.85">ผู้ติดตาม</span></div>
  <div class="pp-clout-sub">${wk >= 0 ? ICON.arrowIn : ICON.arrowOut}
   <span>7 วันนี้ ${wk >= 0 ? '+' : ''}${wk.toLocaleString('en-US')}${ghostOn() ? '' : ' · ปิดผีอยู่'}</span></div>
 </div>`;
}
function renderFeed() {
 const scroll = document.getElementById('pp-feed-scroll');
 const title = document.getElementById('pp-feed-title');
 const tools = document.getElementById('pp-feed-tools');
 const fab = document.getElementById('pp-feed-add');
 if (!scroll) return;
 document.querySelectorAll('#pp-feed-tabbar button').forEach(b => b.classList.toggle('on', b.dataset.feedtab === ppFeedTab));
 const badge = document.getElementById('pp-act-badge');
 if (badge) { const n = unreadNotifCount(); badge.textContent = n > 99 ? '99+' : String(n); badge.style.display = n ? 'block' : 'none'; }

 if (ppFeedTab === 'home') {
 if (title) title.textContent = 'ฟีด';
 if (tools) tools.innerHTML = `
 <button class="pp-nav-action" id="pp-feed-news" title="ข่าว">${ICON.compass}</button>
 <button class="pp-nav-action" id="pp-feed-gen-btn" title="ให้บอทเคลื่อนไหว">${ICON.generate}</button>
 <button class="pp-nav-action pp-stop" id="pp-feed-stop-btn" title="หยุด" style="display:none">${ICON.stop}</button>`;
 if (fab) fab.style.display = 'flex';
 renderFeedHome(scroll);
 } else if (ppFeedTab === 'news') {
 if (title) title.textContent = 'ข่าว';
 if (tools) tools.innerHTML = `<button class="pp-nav-action" id="pp-news-gen" title="โหลดข่าวใหม่">${ICON.generate}</button>`;
 if (fab) fab.style.display = 'none';
 scroll.innerHTML = `<div id="pp-newsapp-list" class="pp-list" style="overflow:visible"></div>`;
 renderNewsApp();
 } else if (ppFeedTab === 'explore') {
 if (title) title.textContent = 'สำรวจ';
 if (tools) tools.innerHTML = `<button class="pp-nav-action" id="pp-feed-gen-btn" title="ให้บอทเคลื่อนไหว">${ICON.generate}</button>`;
 if (fab) fab.style.display = 'none';
 renderFeedExplore(scroll);
 } else if (ppFeedTab === 'activity') {
 if (title) title.textContent = 'กิจกรรม';
 if (tools) tools.innerHTML = `<button class="pp-nav-action" id="pp-act-clear" title="ทำเครื่องหมายอ่านแล้ว">${ICON.check}</button>`;
 if (fab) fab.style.display = 'none';
 renderFeedActivity(scroll);
 } else {
 if (title) title.textContent = 'โปรไฟล์';
 if (tools) tools.innerHTML = `
 <button class="pp-nav-action" id="pp-prof-privacy" title="ความเป็นส่วนตัว">${getCfg().accountLocked ? ICON.lock : ICON.unlock}</button>
 <button class="pp-nav-action" data-nav="profedit" title="แก้ไขโปรไฟล์">${ICON.compose}</button>`;
 if (fab) fab.style.display = 'none';
 renderFeedProfile(scroll);
 }
}
function storyTrayHTML() {
 pruneStories();
 const stories = liveStories();
 const cfg = getCfg();
 const mine = stories.filter(s => s.author === 'user');
 let html = `<div class="pp-story-cell" data-storyauthor="user">
 <div class="pp-story-ring${mine.length ? (storyHasUnseen('user') ? ' unseen' : ' seen') : ' add'}">
 ${userAvatarHTML(64)}${mine.length ? '' : `<span class="pp-story-plus">${ICON.plus}</span>`}
 </div>
 <div class="pp-story-cell-name">สตอรี่ของฉัน</div>
 </div>`;
 getContacts().forEach(c => {
 if (ppScopeActive() && !ppContactInScope(c)) return;
 if (isBlocked(c.id)) return;
 if (!stories.some(s => s.author === c.id)) return;
 const closeOnly = stories.some(s => s.author === c.id && s.closeOnly);
 html += `<div class="pp-story-cell" data-storyauthor="${esc(c.id)}">
 <div class="pp-story-ring${storyHasUnseen(c.id) ? (closeOnly ? ' close' : ' unseen') : ' seen'}">${contactAvatarHTML(c, 64)}</div>
 <div class="pp-story-cell-name">${esc(dname(c))}</div>
 </div>`;
 });
 return `<div class="pp-story-tray">${html}</div>`;
}
function postHTML(p, full) {
 const av = p.author === 'user' ? ppUserAvatarCache : (findContact(p.author)?.avatar);
 const liked = (p.likes || []).includes('user');
 const saved = isSaved(p.id);
 const keys = postMediaKeys(p);
 const cmCount = (p.comments || []).length;
 const vis = p.visibility || getCfg().postVisibilityDefault || 'all';
 const isRepost = !!p.repostOf;
 const rpCount = repostCount(p.id);
 const rpMine = userReposted(p.id);
 let media = '';
 if (keys.length > 1) {
 media = `<div class="pp-post-media"><div class="pp-carousel" data-carousel="${esc(p.id)}">
 ${keys.map((k, i) => `<div class="pp-post-img" data-postimg="${esc(p.id)}:${i}"></div>`).join('')}
 </div><div class="pp-carousel-dots">${keys.map((_, i) => `<i${i === 0 ? ' class="on"' : ''}></i>`).join('')}</div>
 <div class="pp-post-hearts" data-hearts="${esc(p.id)}"></div></div>`;
 } else if (keys.length === 1) {
 media = `<div class="pp-post-media"><div class="pp-post-img" data-postimg="${esc(p.id)}:0" data-dbl="${esc(p.id)}"></div>
 <div class="pp-post-hearts" data-hearts="${esc(p.id)}"></div></div>`;
 }
 let textBlock = '';
 const bodyText = isRepost ? (p.quote || '') : (p.text || '');
 if (bodyText) {
 const withTags = linkifyFeedText(bodyText);
 textBlock = (p.bg && !isRepost)
 ? `<div class="pp-post-textbg" style="background:${p.bg}" data-postopen="${esc(p.id)}">${withTags}</div>`
 : `<div class="pp-post-text"${full ? '' : ` data-postopen="${esc(p.id)}"`}>${withTags}</div>`;
 }
 let pollBlock = '';
 if (p.poll) {
 const total = (p.poll.options || []).reduce((s, o) => s + (o.votes || []).length, 0);
 pollBlock = `<div class="pp-poll-post"><div class="pp-poll">
 <div class="pp-poll-q">${ICON.poll} ${esc(p.poll.question)}</div>
 ${(p.poll.options || []).map((o, i) => {
 const v = (o.votes || []).length, pct = total ? Math.round(v / total * 100) : 0, mine = (o.votes || []).includes('user');
 return `<div class="pp-poll-opt" data-postvote="${esc(p.id)}:${i}">
 <div class="pp-poll-fill" style="width:${pct}%"></div>
 <div class="pp-poll-lb"><span>${mine ? ICON.check : ''} ${esc(o.text)}</span><span>${v ? pct + '%' : ''}</span></div></div>`;
 }).join('')}
 <div class="pp-poll-total">${total ? `${total} โหวต` : 'ยังไม่มีใครโหวต'}</div>
 </div></div>`;
 }
 let qBlock = '';
 if (p.question) {
 qBlock = `<div class="pp-poll-post"><div class="pp-poll">
 <div class="pp-poll-q">${ICON.comment} ${esc(p.question)}</div>
 <div class="pp-poll-total">กล่องคำถาม — บอทตอบได้ในคอมเมนต์</div></div></div>`;
 }
 const shared = full ? postSharedTo(p.id) : [];
 const sharedNote = shared.length
 ? `<div class="pp-post-shared-note" data-warpshare="${esc(shared[0].tid)}:${esc(shared[0].mid)}">${ICON.goto}
 <span>แชร์ให้ ${esc(threadName(shared[0].tid))}${shared.length > 1 ? ` และอีก ${shared.length - 1} คน` : ''} แล้ว · แตะเพื่อไปดู</span></div>`
 : '';
 const stats = (full && p.author === 'user')
 ? `<div class="pp-post-stats">
 <span>${Object.keys(p.views || {}).length} คนเห็น</span>
 <span>${postTotalLikes(p)} ถูกใจ</span>
 <span>${rpCount} รีโพสต์</span>
 <span>${(p.saves || 0)} บันทึก</span>
 <span>${visibilityLabel(vis)}</span></div>`
 : '';
 const repostTag = isRepost
 ? `<div class="pp-repost-tag">${ICON.repost}<span>${esc(postAuthorLabel(p))} รีโพสต์</span></div>`
 : '';

 return `<div class="pp-post${full ? ' pp-post-full' : ''}" data-postid="${esc(p.id)}">
 ${repostTag}
 <div class="pp-post-head">
 ${avHTML(av, postAuthorLabel(p)[0], 38)}
 <div class="pp-post-who">
 <div class="pp-post-name">${esc(postAuthorLabel(p))}${p.closeOnly ? ICON.users : ''}${vis === 'none' ? ICON.lock : ''}${toneBadge(p)}${heatBadge(p)}</div>
 <div class="pp-post-age">${esc(fmtNoteAge(p.ts))}${p.kind === 'news' ? ' · ข่าว' : ''}${p.edited ? ' · แก้ไขแล้ว' : ''}</div>
 </div>
 <button class="pp-post-more" data-postmenu="${esc(p.id)}">${ICON.menu}</button>
 </div>
 ${textBlock}
 ${isRepost ? quoteCardHTML(p.repostOf) : ''}
 ${media}${pollBlock}${qBlock}${sharedNote}
 <div class="pp-post-actions">
 <button data-postlike="${esc(p.id)}"${liked ? ' class="on"' : ''}>${liked ? ICON.heart : ICON.heartOut}<span>${postTotalLikes(p)}</span></button>
 <button data-postopen="${esc(p.id)}">${ICON.comment}<span>${cmCount}</span></button>
 <button class="rp${rpMine ? ' on' : ''}" data-postrepost="${esc(p.id)}">${ICON.repost}<span>${rpCount || ''}</span></button>
 <button data-postshare="${esc(p.id)}">${ICON.share}</button>
 <button class="push${saved ? ' saved' : ''}" data-postsave="${esc(p.id)}">${saved ? ICON.bookmark : ICON.bookmarkOut}</button>
 </div>
 ${stats}
 </div>`;
}
function renderFeedHome(scroll) {
 const posts = feedByTab('post');
 let list = posts;
 if (ppExploreTag) list = posts.filter(p => extractHashtags(p.text).includes(ppExploreTag));
 if (ppScopeActive()) {
 list = list.filter(p => p.author === 'user' || p.kind === 'news' || (function () { const c = findContact(p.author); return c && ppContactInScope(c); })());
 }
 scroll.innerHTML = storyTrayHTML()
 + (ppExploreTag ? `<div class="pp-taglist"><button data-tagclear="1">${ICON.close} #${esc(ppExploreTag)}</button></div>` : '')
 + `<div class="pp-feed-list">${list.length
 ? list.map(p => postHTML(p, false)).join('')
 : `<div class="pp-empty">${ICON.feed}<br>${ppExploreTag ? 'ไม่มีโพสต์ในแท็กนี้' : 'ยังไม่มีโพสต์'}<span>แตะปุ่มสร้าง หรือให้บอทเคลื่อนไหว</span></div>`}</div>`;
 hydrateFeedImages();
 bindCarousels();
}
function renderFeedExplore(scroll) {
 const posts = getFeedPosts().filter(p => p.kind !== 'news' && p.author !== 'user' && !isPostArchived(p.id));
 const news = feedByTab('news');
 const tagCount = {};
 getFeedPosts().forEach(p => extractHashtags(p.text).forEach(t => { tagCount[t] = (tagCount[t] || 0) + 1; }));
 const tags = Object.keys(tagCount).sort((a, b) => tagCount[b] - tagCount[a]).slice(0, 12);
 const top = topFeedPosts(5);
 scroll.innerHTML = `
 <div class="pp-search-wrap"><span class="pp-search-ico">${ICON.search}</span>
 <input class="pp-search" id="pp-explore-search" placeholder="ค้นหาโพสต์หรือคน"></div>
 ${tags.length ? `<div class="pp-sec-label" style="padding:0 18px">แท็กมาแรง</div>
 <div class="pp-taglist">${tags.map(t => `<button data-tag="${esc(t)}">#${esc(t)}</button>`).join('')}</div>` : ''}
 ${top.length ? `<div class="pp-sec-label" style="padding:0 18px">5 อันดับยอดนิยม</div>
 <div class="pp-card" style="margin:0 16px 10px">${top.map((p, i) => `<div class="pp-cell tap" data-postopen="${esc(p.id)}">
 <span class="pp-cell-lb"><b style="color:var(--pp-accent);min-width:14px">${i + 1}</b>
 <span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(postAuthorLabel(p))} · ${esc((p.text || '[รูป]').slice(0, 40))}</span></span>
 <span class="pp-cell-val">${postTotalLikes(p)}${ICON.heart}</span></div>`).join('')}</div>` : ''}
 ${news.length ? `<div class="pp-sec-label" style="padding:0 18px">ข่าว</div>
 <div class="pp-feed-list">${news.slice(0, 4).map(p => postHTML(p, false)).join('')}</div>` : ''}
 <div class="pp-sec-label" style="padding:0 18px">โพสต์ทั้งหมด</div>
 ${posts.length
 ? `<div class="pp-gridview">${posts.map(p => gridCellHTML(p)).join('')}</div>`
 : `<div class="pp-empty">${ICON.compass}<br>ยังไม่มีโพสต์จากคนอื่น</div>`}`;
 hydrateFeedImages();
}
function gridCellHTML(p) {
 const k = postFirstMedia(p);
 const keys = postMediaKeys(p);
 return `<div class="pp-gridcell" data-postopen="${esc(p.id)}"${k ? ` data-gridimg="${esc(p.id)}"` : ''}${p.bg ? ` style="background:${p.bg}"` : ''}>
 ${!k ? `<div class="pp-gridcell-txt">${esc((p.text || '').slice(0, 90))}</div>` : ''}
 ${keys.length > 1 ? `<span class="pp-gridcell-badge">${ICON.grid}</span>` : ''}
 ${p.poll ? `<span class="pp-gridcell-badge">${ICON.poll}</span>` : ''}
 </div>`;
}
function renderFeedActivity(scroll) {
 const cfg = getCfg();
 const reqs = cfg.followRequests || [];
 const items = (cfg.notifCenter || []).slice().reverse();
 scroll.innerHTML = `
 ${reqs.length ? `<div class="pp-sec-label" style="padding:0 18px">คำขอติดตาม (${reqs.length})</div>
 <div class="pp-card" style="margin:0 16px 10px">${reqs.map(cid => `<div class="pp-cell">
 <span class="pp-cell-lb">${contactAvatarHTML(findContact(cid) || { name: cid }, 34)} ${esc(cname(cid))}</span>
 <span style="display:flex;gap:6px">
 <button class="pp-btn primary" data-followok="${esc(cid)}" style="padding:6px 12px">รับ</button>
 <button class="pp-btn" data-followno="${esc(cid)}" style="padding:6px 12px">ปฏิเสธ</button>
 </span></div>`).join('')}</div>` : ''}
 ${unseenMentions() ? `<div class="pp-sec-label" style="padding:0 18px">${ICON.at} มีคนแท็กคุณ (${unseenMentions()})</div>
 <div class="pp-card" style="margin:0 16px 10px">${(cfg.mentionsInbox || []).slice().reverse().slice(0, 6).map(mn => `<div class="pp-cell tap" data-mentionopen="${esc(mn.pid)}">
 <span class="pp-cell-lb" style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(cname(mn.cid))}: ${esc(mn.text.slice(0, 46))}</span>
 <span class="pp-cell-val">${esc(fmtNoteAge(mn.ts))}${ICON.chevron}</span></div>`).join('')}</div>` : ''}
 <div class="pp-sec-label" style="padding:0 18px">กิจกรรมทั้งหมด</div>
 ${items.length ? `<div class="pp-list" style="overflow:visible">${items.map(n => {
 const c = n.cid ? findContact(n.cid) : null;
 const icon = n.kind === 'like' ? ICON.heart : n.kind === 'comment' ? ICON.comment
 : n.kind === 'follow' ? ICON.person : n.kind === 'wallet' ? ICON.money
 : n.kind === 'story' ? ICON.camera : n.kind === 'group' ? ICON.users : ICON.messages;
 return `<div class="pp-row" data-notif="${esc(n.id)}">
 ${c ? contactAvatarHTML(c, 42) : avHTML('', 'P', 42)}
 <div class="pp-row-meta">
 <div class="pp-row-name">${esc(c ? dname(c) : 'Pocket Phone')}${n.seen ? '' : `<span class="pp-badge" style="min-width:8px;height:8px;padding:0;border-radius:50%"></span>`}</div>
 <div class="pp-row-sub">${esc(n.text)}</div>
 </div>
 <div class="pp-row-right">
 <span class="pp-row-time">${esc(fmtNoteAge(n.ts))}</span>
 <button class="pp-btn" data-notifdel="${esc(n.id)}" style="padding:4px 9px">${ICON.trash}</button>
 </div>
 </div>`;
 }).join('')}</div>` : `<div class="pp-empty">${ICON.heartOut}<br>ยังไม่มีกิจกรรม</div>`}`;
}
function renderFeedProfile(scroll) {
 const cfg = getCfg();
 const mine = getFeedPosts().filter(p => p.author === 'user');
 const shown = ppProfileTab === 'saved'
 ? getFeedPosts().filter(p => isSaved(p.id))
 : ppProfileTab === 'archived'
 ? getFeedPosts().filter(p => isPostArchived(p.id))
 : mine.filter(p => !isPostArchived(p.id));
 const hl = cfg.storyHighlights || [];
 scroll.innerHTML = `
 <div class="pp-prof-top">
 ${userAvatarHTML(84)}
 <div class="pp-prof-stats">
 <div class="pp-prof-stat"><b>${mine.length}</b><span>โพสต์</span></div>
 <div class="pp-prof-stat" data-followerlist="1"><b>${totalFollowerCount().toLocaleString('en-US')}</b><span>ผู้ติดตาม</span></div>
 <div class="pp-prof-stat" data-followinglist="1"><b>${(cfg.following || []).length}</b><span>กำลังติดตาม</span></div>
 </div>
 </div>
 <div class="pp-prof-name">${esc(getUserDisplayName())}${cfg.accountLocked ? ICON.lock : ''}</div>
 <div class="pp-prof-handle">@${esc(getUserHandle())}</div>
 ${cfg.userBio ? `<div class="pp-prof-bio">${esc(cfg.userBio)}</div>` : ''}
 ${cfg.userLink ? `<div class="pp-prof-link">${ICON.link}${esc(cfg.userLink)}</div>` : ''}
 ${cloutCardHTML()}
 <div class="pp-prof-btns">
 <button class="pp-btn wide" data-nav="profedit">แก้ไขโปรไฟล์</button>
 <button class="pp-btn wide" data-nav="account">ความเป็นส่วนตัว</button>
 </div>
 ${hl.length ? `<div class="pp-highlights">${hl.map(h => `<div class="pp-hl-cell" data-hl="${esc(h.id)}">
 <div class="pp-hl-ring" data-hlimg="${esc(h.id)}"></div>
 <div class="pp-hl-name">${esc(h.name)}</div></div>`).join('')}</div>` : ''}
 <div class="pp-tabs pp-proftabs" style="border-top:.5px solid var(--pp-sep)">
 <button data-proftab="posts"${ppProfileTab === 'posts' ? ' class="on"' : ''}>${ICON.grid}<span>โพสต์</span></button>
 <button data-proftab="saved"${ppProfileTab === 'saved' ? ' class="on"' : ''}>${ICON.bookmarkOut}<span>บันทึกไว้</span></button>
 <button data-proftab="archived"${ppProfileTab === 'archived' ? ' class="on"' : ''}>${ICON.archive}<span>เก็บถาวร</span></button>
 </div>
 ${shown.length
 ? `<div class="pp-gridview">${shown.map(p => gridCellHTML(p)).join('')}</div>`
 : `<div class="pp-empty">${ICON.grid}<br>${ppProfileTab === 'saved' ? 'ยังไม่มีโพสต์ที่บันทึก' : ppProfileTab === 'archived' ? 'ยังไม่มีโพสต์ที่เก็บถาวร' : 'ยังไม่มีโพสต์'}</div>`}`;
 hydrateFeedImages();
 (cfg.storyHighlights || []).forEach(h => {
 const el = scroll.querySelector(`[data-hlimg="${CSS.escape(h.id)}"]`);
 if (!el) return;
 const sid = (h.storyIds || [])[0];
 const s = getStories().find(x => x.id === sid);
 if (s && s.type === 'image') loadMedia('story-' + s.id).then(img => { if (img) el.style.backgroundImage = `url(${img})`; });
 else if (s) el.style.background = s.bg || STORY_BGS[0];
 });
}
function hydrateFeedImages() {
 document.querySelectorAll('[data-postimg]').forEach(el => {
 const [pid, i] = el.dataset.postimg.split(':');
 const p = findPost(pid);
 if (!p) return;
 const keys = postMediaKeys(p);
 const k = keys[+i];
 if (k) loadMedia(k).then(img => { if (img) el.style.backgroundImage = `url(${img})`; });
 });
 document.querySelectorAll('[data-quoteimg]').forEach(el => {
 const p = findPost(el.dataset.quoteimg);
 const k = p && postFirstMedia(p);
 if (k) loadMedia(k).then(img => { if (img) el.style.backgroundImage = `url(${img})`; });
 });
 document.querySelectorAll('[data-gridimg]').forEach(el => {
 const p = findPost(el.dataset.gridimg);
 const k = p && postFirstMedia(p);
 if (k) loadMedia(k).then(img => { if (img) el.style.backgroundImage = `url(${img})`; });
 });
}
function bindCarousels() {
 document.querySelectorAll('[data-carousel]').forEach(car => {
 car.addEventListener('scroll', () => {
 const i = Math.round(car.scrollLeft / car.offsetWidth);
 const dots = car.parentElement.querySelectorAll('.pp-carousel-dots i');
 dots.forEach((d, di) => d.classList.toggle('on', di === i));
 }, { passive: true });
 });
}
function renderPost() {
 const p = findPost(ppActivePost);
 const body = document.getElementById('pp-post-body');
 if (!p || !body) { ppNav('feed'); return; }
 // นับ view
 if (!p.views) p.views = {};
 const comments = p.comments || [];
 const kids = pid => comments.filter(cm => cm.parentId === pid);
 const cmHTML = (cm, depth) => {
 const av = cm.ghost ? '' : (cm.author === 'user' ? ppUserAvatarCache : (findContact(cm.author)?.avatar));
 const liked = (cm.likes || []).includes('user');
 const parent = cm.parentId ? comments.find(x => x.id === cm.parentId) : null;
 let h = `<div class="pp-cmt${depth ? ' child' : ''}" data-cmtid="${esc(cm.id)}">
 ${avHTML(av, commentAuthorLabel(cm)[0], 30)}
 <div class="pp-cmt-body">
 <div class="pp-cmt-bubble" data-cmtmenu="${esc(cm.id)}">
 <span class="pp-cmt-name">${esc(commentAuthorLabel(cm))}${cm.ghost ? '<span class="pp-ghost-badge">คนแปลกหน้า</span>' : ''}</span>
 ${parent ? `<span class="pp-cmt-to" data-cmtwarp="${esc(cm.parentId)}">${ICON.reply} ${esc(commentAuthorLabel(parent))}</span>` : ''}
 <span class="pp-cmt-txt">${linkifyFeedText(cm.text)}</span>
 </div>
 <div class="pp-cmt-meta">
 <span>${esc(fmtNoteAge(cm.ts))}${cm.edited ? ' · แก้ไขแล้ว' : ''}</span>
 <button data-cmtreply="${esc(cm.id)}">ตอบกลับ</button>
 <button data-cmtlike="${esc(cm.id)}"${liked ? ' class="on"' : ''}>${liked ? ICON.heart : ICON.heartOut}<span>${commentTotalLikes(cm)}</span></button>
 <button data-cmtdel="${esc(cm.id)}">${ICON.trash}</button>
 </div>
 </div>
 </div>`;
 kids(cm.id).forEach(ch => h += cmHTML(ch, depth + 1));
 return h;
 };
 const roots = comments.filter(cm => !cm.parentId);
 body.innerHTML = postHTML(p, true)
 + `<div class="pp-cmt-head">คอมเมนต์ (${comments.length})</div>`
 + (roots.length ? roots.map(cm => cmHTML(cm, 0)).join('')
 : `<div class="pp-sys">ยังไม่มีคอมเมนต์ · แตะปุ่มบนขวาให้บอทคอมเมนต์ หรือพิมพ์เอง</div>`);
 hydrateFeedImages();
 bindCarousels();
}

// ── post actions ──
function toggleFeedLike(pid) {
 const p = findPost(pid);
 if (!p) return;
 if (!p.likes) p.likes = [];
 const i = p.likes.indexOf('user');
 if (i >= 0) { p.likes.splice(i, 1); ppLog('feed', `เลิกถูกใจโพสต์ของ ${postAuthorLabel(p)} ("${(p.text || '[รูป]').slice(0, 50)}")`); }
 else { p.likes.push('user'); ppLog('feed', `กดถูกใจโพสต์ของ ${postAuthorLabel(p)} ("${(p.text || '[รูป]').slice(0, 50)}")`); }
 saveCfg();
 if (ppCurrentScreen === 'postview') renderPost(); else renderFeed();
}
function flyHeart(pid) {
 const box = document.querySelector(`[data-hearts="${CSS.escape(pid)}"]`);
 if (!box) return;
 const h = document.createElement('div');
 h.className = 'pp-fly-heart';
 h.style.left = 'calc(50% - 32px)';
 h.style.top = 'calc(50% - 32px)';
 h.innerHTML = ICON.heart;
 box.appendChild(h);
 h.addEventListener('animationend', () => h.remove());
}
function toggleSavePost(pid) {
 const cfg = getCfg();
 const p = findPost(pid);
 const i = cfg.savedPosts.indexOf(pid);
 if (i >= 0) cfg.savedPosts.splice(i, 1);
 else { cfg.savedPosts.push(pid); if (p) p.saves = (p.saves || 0) + 1; }
 saveCfg();
 ppLogMinor('feed', i >= 0 ? `เลิกบันทึกโพสต์ของ ${p ? postAuthorLabel(p) : '?'}` : `บันทึกโพสต์ของ ${p ? postAuthorLabel(p) : '?'} ไว้`);
 if (ppCurrentScreen === 'postview') renderPost(); else renderFeed();
 ppToast(i >= 0 ? 'เอาออกจากที่บันทึกแล้ว' : 'บันทึกโพสต์แล้ว');
}
function ppVotePostPoll(pid, oi) {
 const p = findPost(pid);
 if (!p || !p.poll) return;
 (p.poll.options || []).forEach(o => { o.votes = (o.votes || []).filter(v => v !== 'user'); });
 const opt = p.poll.options[oi];
 if (!opt) return;
 opt.votes = opt.votes || [];
 opt.votes.push('user');
 saveCfg();
 ppLog('feed', `โหวตโพลของ ${postAuthorLabel(p)} ("${p.poll.question}") เลือก "${opt.text}"`);
 if (ppCurrentScreen === 'postview') renderPost(); else renderFeed();
}
function ppPostMenu(pid) {
 const p = findPost(pid);
 if (!p) return;
 const mine = p.author === 'user';
 const items = [
 { label: userReposted(pid) ? 'รีโพสต์อีกครั้ง' : 'รีโพสต์', icon: ICON.repost, onClick: () => ppRepostMenu(pid) },
 { label: 'แชร์เข้าแชท', icon: ICON.share, onClick: () => ppSharePostToChat(pid) },
 { label: isSaved(pid) ? 'เลิกบันทึก' : 'บันทึกโพสต์', icon: isSaved(pid) ? ICON.bookmark : ICON.bookmarkOut, onClick: () => toggleSavePost(pid) },
 ];
 if (mine) {
 items.push({ label: 'แก้ไขข้อความ', icon: ICON.compose, onClick: () => {
 ppPrompt('แก้ไขโพสต์', p.text || '', v => {
 const before = p.text;
 p.text = v; p.edited = true; saveCfg();
 ppLog('feed', 'แก้ไขโพสต์ของตัวเอง', [`จาก: "${String(before || '').slice(0, 60)}"`, `เป็น: "${v}"`]);
 if (ppCurrentScreen === 'postview') renderPost(); else renderFeed();
 }, { rows: 4 });
 } });
 items.push({ label: 'เปลี่ยนใครเห็นได้', icon: ICON.eye, onClick: () => ppPostVisibilityMenu(pid) });
 items.push({ label: isPostArchived(pid) ? 'เอาออกจากเก็บถาวร' : 'เก็บถาวร', icon: ICON.archive, onClick: () => {
 const cfg = getCfg();
 const i = cfg.archivedPosts.indexOf(pid);
 if (i >= 0) cfg.archivedPosts.splice(i, 1); else cfg.archivedPosts.push(pid);
 saveCfg();
 ppLogMinor('feed', i >= 0 ? 'เอาโพสต์ออกจากเก็บถาวร' : 'เก็บโพสต์เข้าถาวร');
 renderFeed();
 ppToast(i >= 0 ? 'เอาออกแล้ว' : 'เก็บถาวรแล้ว');
 } });
 }
 items.push({ label: 'ลบโพสต์', icon: ICON.trash, danger: true, onClick: () => {
 ppConfirm('ลบโพสต์', 'ลบโพสต์นี้และคอมเมนต์ทั้งหมด?', () => {
 const cfg = getCfg();
 postMediaKeys(p).forEach(k => delMedia(k));
 cfg.feedPosts = cfg.feedPosts.filter(x => x.id !== pid);
 cfg.savedPosts = cfg.savedPosts.filter(x => x !== pid);
 cfg.archivedPosts = cfg.archivedPosts.filter(x => x !== pid);
 saveCfg();
 ppLog('feed', `ลบโพสต์ "${(p.text || '[รูป]').slice(0, 50)}"`);
 if (ppCurrentScreen === 'postview') ppNav('feed'); else renderFeed();
 ppToast('ลบแล้ว');
 }, 'ลบ');
 } });
 ppSheet(null, items);
}
function ppPostVisibilityMenu(pid) {
 const p = findPost(pid);
 if (!p) return;
 const opts = ['all', 'followers', 'close', 'selected', 'none'];
 ppSheet('ใครเห็นโพสต์นี้ได้', opts.map(v => ({
 label: visibilityLabel(v) + ((p.visibility || 'all') === v ? ' ·' : ''),
 icon: v === 'none' ? ICON.lock : v === 'close' ? ICON.users : ICON.eye,
 onClick: () => {
 if (v === 'selected') {
 ppMultiSelect({ title: 'เลือกคนที่เห็นได้', selected: p.allowed || [], onDone: arr => {
 p.visibility = 'selected'; p.allowed = arr; saveCfg();
 ppLog('feed', `เปลี่ยนการมองเห็นโพสต์เป็น เฉพาะ ${arr.map(cname).join(', ') || 'ไม่มีใคร'}`);
 renderFeed(); ppToast('บันทึกแล้ว');
 } });
 return;
 }
 p.visibility = v; saveCfg();
 ppLog('feed', `เปลี่ยนการมองเห็นโพสต์เป็น "${visibilityLabel(v)}"`);
 if (ppCurrentScreen === 'postview') renderPost(); else renderFeed();
 ppToast('บันทึกแล้ว');
 }
 })));
}
function ppRepostMenu(pid) {
 const src = findPost(pid);
 if (!src) return;
 ppSheet('รีโพสต์', [
 { label: 'รีโพสต์เลย', icon: ICON.repost, onClick: () => {
 const np = doRepost(pid, '');
 if (!np) return;
 ppLog('feed', `รีโพสต์ของ ${postAuthorLabel(src)}`, [`เนื้อหา: "${(src.text || '[รูป]').slice(0, 70)}"`]);
 if (ppCurrentScreen === 'postview') renderPost(); else renderFeed();
 ppToast('รีโพสต์แล้ว');
 } },
 { label: 'รีโพสต์พร้อมเขียนความเห็น', icon: ICON.compose, onClick: () => {
 ppPrompt('เขียนความเห็นทับ', '', v => {
 const np = doRepost(pid, v);
 if (!np) return;
 ppLog('feed', `รีโพสต์ของ ${postAuthorLabel(src)} พร้อมเขียนว่า "${v}"`, [`โพสต์เดิม: "${(src.text || '[รูป]').slice(0, 70)}"`]);
 if (ppCurrentScreen === 'postview') renderPost(); else renderFeed();
 ppToast('รีโพสต์แล้ว');
 }, { rows: 3, placeholder: 'ความเห็นของคุณ' });
 } },
 ]);
}
function ppSharePostToChat(pid) {
 const p = findPost(pid);
 if (!p) return;
 ppPickContact('แชร์ให้ใคร', cid => {
 pushThreadMsg(cid, { from: 'me', type: 'sharedpost', postId: pid });
 ppLog('feed', `แชร์โพสต์ของ ${postAuthorLabel(p)} ให้ ${cname(cid)}`, [`เนื้อหาโพสต์: "${(p.text || '[รูป]').slice(0, 80)}"`]);
 ppActiveContact = findContact(cid); ppActiveGroup = null; ppNav('chat');
 ppToast('แชร์เข้าแชทแล้ว');
 });
}
function ppSharedCardMenu(idx) {
 const tid = curTid();
 if (!tid) return;
 const m = getThread(tid)[idx];
 if (!m) return;
 ppSheet('โพสต์ที่แชร์', [
 { label: 'ตอบข้อความนี้', icon: ICON.reply, onClick: () => ppReplyToMsg(idx) },
 { label: 'แชร์ต่อ', icon: ICON.share, onClick: () => ppSharePostToChat(m.postId) },
 { label: 'ลบข้อความนี้', icon: ICON.trash, danger: true, onClick: () => ppDeleteMsg(idx) },
 ]);
}
function ppWarpToShared(tid, mid) {
 if (isGroupId(tid)) { const g = getGroup(tid); if (!g) return; ppActiveGroup = g; ppActiveContact = null; }
 else { const c = findContact(tid); if (!c) return; ppActiveContact = c; ppActiveGroup = null; }
 ppHistShown = 999;
 ppNav('chat');
 setTimeout(() => ppWarpTo(mid), 300);
}
function ppSendComment() {
 const p = findPost(ppActivePost);
 if (!p) return;
 const inp = document.getElementById('pp-comment-input');
 const t = (inp.value || '').trim();
 if (!t) return;
 inp.value = ''; inp.style.height = 'auto';
 if (!p.comments) p.comments = [];
 p.comments.push({ id: newId(), author: 'user', text: t, ts: Date.now(), likes: [], extraLikes: 0, parentId: null });
 saveCfg();
 const mns = extractMentions(t).map(h => { const r = resolveMention(h); return r && r.contact ? dname(r.contact) : null; }).filter(Boolean);
 ppLog('feed', `คอมเมนต์โพสต์ของ ${postAuthorLabel(p)} ว่า "${t}"`,
 [`โพสต์: "${(p.text || '[รูป]').slice(0, 60)}"`].concat(mns.length ? [`แท็กถึง: ${mns.join(', ')}`] : []));
 renderPost();
}
function ppReplyComment(cid) {
 const p = findPost(ppActivePost);
 if (!p) return;
 const parent = (p.comments || []).find(x => x.id === cid);
 if (!parent) return;
 ppReplyComposer({
 title: 'ตอบคอมเมนต์', quotedLabel: commentAuthorLabel(parent), quoted: parent.text,
 onOk: text => {
 p.comments.push({ id: newId(), author: 'user', text, ts: Date.now(), likes: [], extraLikes: 0, parentId: cid });
 saveCfg();
 ppLog('feed', `ตอบคอมเมนต์ของ ${commentAuthorLabel(parent)} ว่า "${text}"`, [`คอมเมนต์เดิม: "${String(parent.text).slice(0, 60)}"`]);
 renderPost();
 }
 });
}
function toggleCommentLike(cid) {
 const p = findPost(ppActivePost);
 if (!p) return;
 const cm = (p.comments || []).find(x => x.id === cid);
 if (!cm) return;
 if (!cm.likes) cm.likes = [];
 const i = cm.likes.indexOf('user');
 if (i >= 0) cm.likes.splice(i, 1); else cm.likes.push('user');
 saveCfg();
 ppLog('feed', i >= 0 ? `เลิกถูกใจคอมเมนต์ของ ${commentAuthorLabel(cm)}` : `กดถูกใจคอมเมนต์ของ ${commentAuthorLabel(cm)} ("${String(cm.text).slice(0, 40)}")`);
 renderPost();
}
function ppCommentActions(cid) {
 const p = findPost(ppActivePost);
 if (!p) return;
 const cm = (p.comments || []).find(x => x.id === cid);
 if (!cm) return;
 const items = [{ label: 'ตอบกลับ', icon: ICON.reply, onClick: () => ppReplyComment(cid) }];
 if (cm.author === 'user') items.push({ label: 'แก้ไข', icon: ICON.compose, onClick: () => {
 ppPrompt('แก้ไขคอมเมนต์', cm.text, v => {
 if (!v) return;
 const before = cm.text;
 cm.text = v; cm.edited = true; saveCfg();
 ppLog('feed', 'แก้ไขคอมเมนต์ของตัวเอง', [`จาก: "${String(before).slice(0, 50)}"`, `เป็น: "${v}"`]);
 renderPost();
 });
 } });
 items.push({ label: 'ลบ', icon: ICON.trash, danger: true, onClick: () => ppDeleteComment(cid) });
 ppSheet(null, items);
}
function ppDeleteComment(cid) {
 const p = findPost(ppActivePost);
 if (!p) return;
 const cm = (p.comments || []).find(x => x.id === cid);
 ppConfirm('ลบคอมเมนต์', 'ลบคอมเมนต์นี้และที่ตอบใต้ทั้งหมด?', () => {
 const del = new Set([cid]);
 let changed = true;
 while (changed) {
 changed = false;
 (p.comments || []).forEach(x => { if (x.parentId && del.has(x.parentId) && !del.has(x.id)) { del.add(x.id); changed = true; } });
 }
 p.comments = (p.comments || []).filter(x => !del.has(x.id));
 saveCfg();
 ppLog('feed', `ลบคอมเมนต์${cm ? ` ("${String(cm.text).slice(0, 40)}")` : ''} จากโพสต์ของ ${postAuthorLabel(p)}`);
 renderPost();
 ppToast('ลบคอมเมนต์แล้ว');
 }, 'ลบ');
}
function ppCommentWarp(cid) {
 const el = document.querySelector(`#pp-post-body .pp-cmt[data-cmtid="${CSS.escape(cid)}"]`);
 if (!el) return;
 el.scrollIntoView({ behavior: 'smooth', block: 'center' });
 el.classList.add('pp-warp-hl');
 setTimeout(() => el.classList.remove('pp-warp-hl'), 1600);
}

// ── สร้างโพสต์ ──
function renderNewPost() {
 const d = ppNewPostDraft || (ppNewPostDraft = {
 kind: 'post', text: '', mediaKeys: [], previews: [], captions: [],
 bg: '', poll: null, question: '', responders: [], knowEachOther: true,
 visibility: getCfg().postVisibilityDefault || 'all', allowed: [], closeOnly: false,
 });
 const t = document.getElementById('pp-newpost-title');
 if (t) t.textContent = d.kind === 'news' ? 'เขียนข่าว' : 'สร้างโพสต์';
 const body = document.getElementById('pp-newpost-body');
 if (!body) return;
 const imgs = d.previews.map((src, i) => `<div class="pp-post-img" style="background-image:url(${src});aspect-ratio:1;border-radius:14px;margin-bottom:6px" data-rmimg="${i}"></div>
 <input class="pp-input-line" data-capidx="${i}" placeholder="คำบรรยายรูปที่ ${i + 1} (บอทเห็นข้อความนี้)" value="${esc(d.captions[i] || '')}" style="margin-bottom:10px">`).join('');
 body.innerHTML = `
 <div class="pp-seg" style="margin:0 0 12px">
 <button data-npkind="post"${d.kind === 'post' ? ' class="on"' : ''}>โพสต์</button>
 <button data-npkind="news"${d.kind === 'news' ? ' class="on"' : ''}>ข่าว</button>
 </div>
 <div class="pp-sec-label">ข้อความ</div>
 <textarea class="pp-input-line" id="pp-np-text" rows="4" placeholder="เขียนอะไรสักหน่อย… ใช้ #แท็ก ได้">${esc(d.text)}</textarea>
 <div class="pp-sec-label">พื้นหลังข้อความ (ถ้าไม่ใส่รูป)</div>
 <div class="pp-swatches">
 <button class="pp-swatch${!d.bg ? ' on' : ''}" data-npbg="" style="background:var(--pp-fill2)">ไม่ใส่</button>
 ${POST_BGS.map(b => `<button class="pp-swatch${d.bg === b ? ' on' : ''}" data-npbg="${esc(b)}" style="background:${b}"></button>`).join('')}
 </div>
 <div class="pp-sec-label">รูปภาพ (เลือกได้หลายรูป)</div>
 ${imgs}
 <div class="pp-btn-row" style="margin:0 0 6px">
 <label class="pp-upload">${ICON.camera} เลือกรูป<input type="file" accept="image/*" multiple hidden id="pp-np-file"></label>
 ${d.previews.length ? `<button class="pp-btn" id="pp-np-capai">${ICON.generate}ให้ AI อ่านภาพ</button>` : ''}
 ${d.previews.length ? `<button class="pp-btn" id="pp-np-imgclear">เอารูปออกทั้งหมด</button>` : ''}
 </div>
 <div class="pp-sec-label">ลูกเล่น</div>
 <div class="pp-card">
 <div class="pp-cell tap" id="pp-np-poll"><span class="pp-cell-lb">${ICON.poll} โพล</span>
 <span class="pp-cell-val">${d.poll ? esc(d.poll.question.slice(0, 18)) : 'ไม่มี'}${ICON.chevron}</span></div>
 <div class="pp-cell tap" id="pp-np-question"><span class="pp-cell-lb">${ICON.comment} กล่องคำถาม</span>
 <span class="pp-cell-val">${d.question ? esc(d.question.slice(0, 18)) : 'ไม่มี'}${ICON.chevron}</span></div>
 </div>
 <div class="pp-sec-label">ใครเห็นโพสต์นี้ได้</div>
 <div class="pp-card">
 <div class="pp-cell"><span class="pp-cell-lb">${ICON.eye} การมองเห็น</span>
 <select class="pp-sel" id="pp-np-vis">
 ${['all', 'followers', 'close', 'selected', 'none'].map(v => `<option value="${v}"${d.visibility === v ? ' selected' : ''}>${visibilityLabel(v)}</option>`).join('')}
 </select></div>
 <div class="pp-cell tap" id="pp-np-allowed" style="${d.visibility === 'selected' ? '' : 'display:none'}">
 <span class="pp-cell-lb">เลือกคน</span><span class="pp-cell-val">${d.allowed.length} คน${ICON.chevron}</span></div>
 <div class="pp-cell tap" id="pp-np-responders"><span class="pp-cell-lb">จำกัดคนที่ตอบได้</span>
 <span class="pp-cell-val">${d.responders.length ? d.responders.length + ' คน' : 'ทุกคน'}${ICON.chevron}</span></div>
 <div class="pp-cell"><span class="pp-cell-lb">ผู้ตอบรู้จักกัน (ตอบโต้กันได้)</span>
 <label class="pp-switch"><input type="checkbox" id="pp-np-know"${d.knowEachOther ? ' checked' : ''}><span></span></label></div>
 </div>
 <div class="pp-hint">คำบรรยายรูปสำคัญ — บอทมองรูปไม่เห็นตรง ๆ ถ้าไม่ใส่ ระบบจะบอกบอทว่า "ไม่ได้บรรยาย"</div>`;
}
function ppNewPostSave() {
 const d = ppNewPostDraft;
 if (!d) return;
 d.text = (document.getElementById('pp-np-text')?.value || '').trim();
 document.querySelectorAll('[data-capidx]').forEach(el => { d.captions[+el.dataset.capidx] = el.value.trim(); });
 d.knowEachOther = document.getElementById('pp-np-know')?.checked !== false;
 d.visibility = document.getElementById('pp-np-vis')?.value || 'all';
 if (!d.text && !d.mediaKeys.length && !d.poll && !d.question) { ppToast('ใส่ข้อความ รูป หรือลูกเล่นก่อน'); return; }
 const cfg = getCfg();
 const post = {
 id: newId(), author: 'user', kind: d.kind,
 text: d.text, bg: d.mediaKeys.length ? '' : d.bg,
 mediaKeys: d.mediaKeys.slice(), captions: d.captions.slice(),
 poll: d.poll, question: d.question,
 responders: d.responders.length ? d.responders.slice() : null,
 allowed: d.visibility === 'selected' ? d.allowed.slice() : null,
 visibility: d.visibility, knowEachOther: d.knowEachOther,
 ts: Date.now(), likes: [], extraLikes: 0, comments: [], views: {}, saves: 0,
 };
 cfg.feedPosts.push(post);
 saveCfg();

 // ★ Action Log — โพสต์ ละเอียด
 const sub = [];
 if (d.text) sub.push(`ข้อความ: "${d.text}"`);
 if (d.mediaKeys.length) {
 d.mediaKeys.forEach((k, i) => {
 sub.push(d.captions[i] ? `รูปที่ ${i + 1} คำบรรยาย: "${d.captions[i]}"` : `รูปที่ ${i + 1}: ไม่ได้บรรยาย`);
 });
 }
 if (d.poll) sub.push(`โพล: "${d.poll.question}" ตัวเลือก ${d.poll.options.map(o => o.text).join(' / ')}`);
 if (d.question) sub.push(`กล่องคำถาม: "${d.question}"`);
 sub.push(`ใครเห็นได้: ${visibilityLabel(d.visibility)}${d.visibility === 'selected' ? ` (${d.allowed.map(cname).join(', ')})` : ''}`);
 const tags = extractHashtags(d.text);
 if (tags.length) sub.push(`แท็ก: ${tags.map(t => '#' + t).join(' ')}`);
 const mns2 = extractMentions(d.text).map(h => { const r = resolveMention(h); return r && r.contact ? dname(r.contact) : null; }).filter(Boolean);
 if (mns2.length) sub.push(`แท็กถึง: ${mns2.join(', ')}`);
 ppLog('feed', d.kind === 'news' ? `เขียนข่าวลงฟีด` : `โพสต์ลงฟีด`, sub);

 ppNewPostDraft = null;
 ppFeedTab = 'home';
 ppNav('feed');
 ppToast('โพสต์แล้ว');
}
async function ppNewPostPickImages(files) {
 const d = ppNewPostDraft;
 if (!d || !files || !files.length) return;
 for (const f of Array.from(files).slice(0, 10)) {
 await new Promise(res => {
 const r = new FileReader();
 r.onload = async () => {
 const key = 'feed-' + newId();
 await saveMedia(key, r.result);
 d.mediaKeys.push(key);
 d.previews.push(r.result);
 d.captions.push('');
 res();
 };
 r.readAsDataURL(f);
 });
 }
 renderNewPost();
}
async function ppNewPostCaptionAI() {
 const d = ppNewPostDraft;
 if (!d || !d.previews.length) return;
 islandStatus('กำลังอ่านภาพ…');
 for (let i = 0; i < d.previews.length; i++) {
 if (d.captions[i]) continue;
 const cap = await captionImageAI(d.previews[i]);
 if (cap) d.captions[i] = cap;
 }
 islandCollapse();
 renderNewPost();
 ppToast('อ่านภาพเสร็จ ตรวจข้อความได้');
}

// ── โปรไฟล์ / บัญชี ──
function renderProfileEdit() {
 const cfg = getCfg();
 const body = document.getElementById('pp-profedit-body');
 if (!body) return;
 body.innerHTML = `
 <div style="display:flex;flex-direction:column;align-items:center;gap:10px;padding:10px 0 16px">
 ${userAvatarHTML(96)}
 <label class="pp-upload">${ICON.upload} เปลี่ยนรูปโปรไฟล์<input type="file" id="pp-prof-av-pick" accept="image/*" hidden></label>
 </div>
 <div class="pp-sec-label">ชื่อที่แสดง</div>
 <input class="pp-input-line" id="pp-pe-name" placeholder="ชื่อ" value="${esc(cfg.userAppName || '')}">
 <div class="pp-sec-label">ชื่อแอค (@handle)</div>
 <input class="pp-input-line" id="pp-pe-handle" placeholder="${esc(getUserHandle())}" value="${esc(cfg.userHandle || '')}">
 <div class="pp-sec-label">bio</div>
 <textarea class="pp-input-line" id="pp-pe-bio" rows="3" placeholder="เขียนอะไรเกี่ยวกับตัวเอง">${esc(cfg.userBio || '')}</textarea>
 <div class="pp-sec-label">ลิงก์</div>
 <input class="pp-input-line" id="pp-pe-link" placeholder="เช่น เพจ หรือเว็บ" value="${esc(cfg.userLink || '')}">
 <div class="pp-sec-label">สเตตัส 24 ชม.</div>
 <div class="pp-card"><div class="pp-cell tap" id="pp-pe-note">
 <span class="pp-cell-lb" style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc((getUserNote() || {}).text || '—')}</span>
 <span class="pp-cell-val">แก้ไข${ICON.chevron}</span></div></div>
 <div class="pp-sec-label">Highlights สตอรี่</div>
 <button class="pp-btn wide" id="pp-pe-hl">จัดการ Highlights (${(cfg.storyHighlights || []).length})</button>`;
}
function ppProfileSave() {
 const cfg = getCfg();
 const before = { name: cfg.userAppName, handle: cfg.userHandle, bio: cfg.userBio, link: cfg.userLink };
 cfg.userAppName = (document.getElementById('pp-pe-name')?.value || '').trim();
 cfg.userHandle = (document.getElementById('pp-pe-handle')?.value || '').trim().replace(/^@/, '');
 cfg.userBio = (document.getElementById('pp-pe-bio')?.value || '').trim();
 cfg.userLink = (document.getElementById('pp-pe-link')?.value || '').trim();
 saveCfg();
 const changes = [];
 if (before.name !== cfg.userAppName) changes.push(`ชื่อแสดง: "${before.name || '—'}" เป็น "${cfg.userAppName || '—'}"`);
 if (before.handle !== cfg.userHandle) changes.push(`ชื่อแอค: "@${before.handle || '—'}" เป็น "@${cfg.userHandle || getUserHandle()}"`);
 if (before.bio !== cfg.userBio) changes.push(`bio: "${cfg.userBio || '—'}"`);
 if (before.link !== cfg.userLink) changes.push(`ลิงก์: "${cfg.userLink || '—'}"`);
 if (changes.length) ppLog('account', 'แก้ไขโปรไฟล์', changes);
 refreshUserAvatar().then(() => { ppFeedTab = 'profile'; ppNav('feed'); });
 ppToast('บันทึกโปรไฟล์แล้ว');
}
function renderAccountSettings() {
 const cfg = getCfg();
 const body = document.getElementById('pp-account-body');
 if (!body) return;
 body.innerHTML = `
 <div class="pp-sec-label">บัญชี</div>
 <div class="pp-card">
 <div class="pp-cell"><span class="pp-cell-lb">${cfg.accountLocked ? ICON.lock : ICON.unlock} ล็อคบัญชี</span>
 <label class="pp-switch"><input type="checkbox" id="pp-acc-lock"${cfg.accountLocked ? ' checked' : ''}><span></span></label></div>
 </div>
 <div class="pp-hint">เมื่อล็อค บอทต้องส่งคำขอติดตามก่อน ผู้ใช้กดรับ/ปฏิเสธในแท็บกิจกรรม และเห็นโพสต์ได้เฉพาะผู้ติดตาม</div>

 <div class="pp-sec-label">ค่าเริ่มต้นการมองเห็นโพสต์</div>
 <div class="pp-card"><div class="pp-cell">
 <span class="pp-cell-lb">${ICON.eye} ใครเห็นโพสต์ใหม่ได้</span>
 <select class="pp-sel" id="pp-acc-vis">
 ${['all', 'followers', 'close', 'selected', 'none'].map(v => `<option value="${v}"${cfg.postVisibilityDefault === v ? ' selected' : ''}>${visibilityLabel(v)}</option>`).join('')}
 </select></div></div>

 <div class="pp-sec-label">รายชื่อ</div>
 <div class="pp-card">
 <div class="pp-cell tap" id="pp-acc-followers"><span class="pp-cell-lb">${ICON.person} ผู้ติดตาม</span>
 <span class="pp-cell-val">${(cfg.followers || []).length}${ICON.chevron}</span></div>
 <div class="pp-cell tap" id="pp-acc-following"><span class="pp-cell-lb">${ICON.person} กำลังติดตาม</span>
 <span class="pp-cell-val">${(cfg.following || []).length}${ICON.chevron}</span></div>
 <div class="pp-cell tap" id="pp-acc-close"><span class="pp-cell-lb">${ICON.users} เพื่อนสนิท</span>
 <span class="pp-cell-val">${(cfg.closeFriends || []).length}${ICON.chevron}</span></div>
 <div class="pp-cell tap" id="pp-acc-restrict"><span class="pp-cell-lb">${ICON.eye} จำกัด</span>
 <span class="pp-cell-val">${(cfg.restricted || []).length}${ICON.chevron}</span></div>
 <div class="pp-cell tap" id="pp-acc-block"><span class="pp-cell-lb">${ICON.ban} บล็อก</span>
 <span class="pp-cell-val">${(cfg.blocked || []).length}${ICON.chevron}</span></div>
 </div>
 <div class="pp-hint">เพื่อนสนิท = คนที่เห็นสตอรี่วงปิด · จำกัด = ไม่คอมเมนต์และไม่ตอบโพสต์ · บล็อก = ไม่โพสต์ ไม่คอมเมนต์ ไม่ทัก</div>`;
}
function ppAccountList(key, title, logLabel) {
 const cfg = getCfg();
 ppMultiSelect({
 title, selected: cfg[key] || [],
 onDone: arr => {
 const before = (cfg[key] || []).slice();
 cfg[key] = arr;
 saveCfg();
 const added = arr.filter(x => !before.includes(x)).map(cname);
 const removed = before.filter(x => !arr.includes(x)).map(cname);
 const sub = [];
 if (added.length) sub.push(`เพิ่ม: ${added.join(', ')}`);
 if (removed.length) sub.push(`เอาออก: ${removed.join(', ')}`);
 if (sub.length) ppLog('account', `แก้ไขรายชื่อ${logLabel}`, sub);
 renderAccountSettings();
 ppToast('บันทึกแล้ว');
 }
 });
}
function ppFollowRespond(cid, accept) {
 const cfg = getCfg();
 cfg.followRequests = (cfg.followRequests || []).filter(x => x !== cid);
 if (accept) {
 if (!cfg.followers.includes(cid)) cfg.followers.push(cid);
 ppLog('account', `รับคำขอติดตามจาก ${cname(cid)}`);
 } else {
 ppLog('account', `ปฏิเสธคำขอติดตามจาก ${cname(cid)}`);
 }
 saveCfg();
 renderFeed();
 ppToast(accept ? 'รับคำขอแล้ว' : 'ปฏิเสธแล้ว');
}

// ══════════════════════════════════════════════════════════
// STORY
// ══════════════════════════════════════════════════════════
function ppStoryAuthorTap(author) {
 if (author === 'user') {
 const mine = liveStories().filter(s => s.author === 'user');
 if (mine.length) openStoryViewer('user'); else ppCreateStory();
 return;
 }
 openStoryViewer(author);
}
function ppCreateStory() {
 ppSheet('ลงสตอรี่', [
 { label: 'ลงรูปภาพ', icon: ICON.image, onClick: () => document.getElementById('pp-story-img-file')?.click() },
 { label: 'ลงข้อความ', icon: ICON.compose, onClick: ppCreateTextStory },
 ]);
}
function ppCreateTextStory() {
 ppPrompt('ข้อความสตอรี่', '', v => {
 if (!v) return;
 const bg = STORY_BGS[Math.floor(Math.random() * STORY_BGS.length)];
 ppStoryVisibility(closeOnly => {
 const cfg = getCfg(), id = newId();
 cfg.stories.push({ id, author: 'user', type: 'text', text: v.slice(0, 220), bg, closeOnly, ts: Date.now(), likes: [], views: {}, replies: [] });
 saveCfg();
 markStorySeen(id);
 const st1 = (getCfg().stories || []).find(x => x.id === id);
 const nG = ghostHauntStory(st1);
 ppLog('story', `ลงสตอรี่ข้อความ${closeOnly ? ' (เฉพาะเพื่อนสนิท)' : ''}`,
  [`ข้อความ: "${v}"`].concat(nG ? [`มีคนแปลกหน้าแอบดู ${nG} คน`] : []));
 renderFeed();
 ppToast('ลงสตอรี่แล้ว');
 });
 }, { rows: 3 });
}
function ppStoryVisibility(cb) {
 ppSheet('ใครเห็นสตอรี่นี้', [
 { label: 'ทุกคน', icon: ICON.eye, onClick: () => cb(false) },
 { label: `เพื่อนสนิท (${(getCfg().closeFriends || []).length} คน)`, icon: ICON.users, onClick: () => cb(true) },
 ]);
}
async function ppAddImageStory(file) {
 if (!file) return;
 const id = newId();
 const dataUrl = await ppReadImageFile(file);
 if (!dataUrl) { ppToast('อ่านไฟล์รูปไม่ได้'); return; }
 const ok = await saveMedia('story-' + id, dataUrl);
 if (!ok) { ppToast('บันทึกรูปไม่สำเร็จ (พื้นที่เก็บข้อมูลอาจเต็ม) ลองรูปที่เล็กลง'); return; }
 const finish = (cap, closeOnly) => {
 const cfg = getCfg();
 cfg.stories.push({ id, author: 'user', type: 'image', mediaKey: 'story-' + id, text: (cap || '').slice(0, 220), closeOnly, ts: Date.now(), likes: [], views: {}, replies: [] });
 saveCfg();
 markStorySeen(id);
 const st0 = (getCfg().stories || []).find(x => x.id === id);
 const nGhost = ghostHauntStory(st0);
 ppLog('story', `ลงสตอรี่รูป${closeOnly ? ' (เฉพาะเพื่อนสนิท)' : ''}`,
  [cap ? `คำบรรยายรูป: "${cap}"` : 'ไม่ได้ใส่คำบรรยายรูป'].concat(nGhost ? [`มีคนแปลกหน้าแอบดู ${nGhost} คน`] : []));
 renderFeed();
 ppToast('ลงสตอรี่แล้ว');
 };
 const withVis = cap => ppStoryVisibility(co => finish(cap, co));
 ppSheet('คำบรรยายสตอรี่', [
 { label: 'ให้ AI อ่านภาพให้', icon: ICON.generate, onClick: async () => {
 islandStatus('กำลังอ่านภาพ…');
 const cap = await captionImageAI(dataUrl);
 islandCollapse();
 if (cap) withVis(cap);
 else ppPrompt('อ่านภาพไม่ได้ พิมพ์เอง (เว้นว่างได้)', '', v => withVis(v));
 } },
 { label: 'พิมพ์คำบรรยายเอง', icon: ICON.compose, onClick: () => ppPrompt('คำบรรยาย (เว้นว่างได้)', '', v => withVis(v)) },
 { label: 'ไม่ใส่คำบรรยาย', icon: ICON.image, onClick: () => withVis('') },
 ]);
}
function openStoryViewer(author) {
 const list = liveStories().filter(s => s.author === author).sort((a, b) => (a.ts || 0) - (b.ts || 0));
 if (!list.length) return;
 ppStoryView = { list, idx: 0, author };
 ppStoryPaused = false;
 const v = document.getElementById('pp-story-viewer');
 if (!v) return;
 v.style.display = 'block';
 renderStoryViewer();
}
function startStoryTimer(s) {
 clearTimeout(ppStoryTimer);
 if (ppStoryPaused) return;
 const dur = s.type === 'image' ? 6500 : 5200;
 const bar = document.querySelector('#pp-story-viewer .pp-sv-bar i.active');
 if (bar) { bar.style.animation = 'none'; void bar.offsetWidth; bar.style.animation = `pp-sv-fill ${dur}ms linear forwards`; }
 ppStoryTimer = setTimeout(() => storyNext(), dur);
}
function renderStoryViewer() {
 const v = document.getElementById('pp-story-viewer');
 if (!v || !ppStoryView) return;
 const { list, idx, author } = ppStoryView;
 const s = list[idx];
 if (!s) { closeStoryViewer(); return; }
 clearTimeout(ppStoryTimer);
 markStorySeen(s.id);
 const isUser = author === 'user';
 const bars = list.map((_, i) => `<div class="pp-sv-bar"><i class="${i < idx ? 'done' : ''}${i === idx ? ' active' : ''}"></i></div>`).join('');
 const avatar = isUser ? ppUserAvatarCache : (findContact(author)?.avatar);
 const body = s.type === 'image'
 ? `<div class="pp-sv-img" id="pp-sv-img"></div>${s.text ? `<div class="pp-sv-cap">${esc(s.text)}</div>` : ''}`
 : `<div class="pp-sv-text" style="background:${s.bg || STORY_BGS[0]};color:${s.color || '#fff'}">${esc(s.text)}</div>`;
 const liked = (s.likes || []).includes('user');
 const footer = isUser
 ? `<div class="pp-sv-footer">
 <button class="pp-sv-btn" data-svviewers="1">${ICON.eye} ผู้ชม ${Object.keys(s.views || {}).length}</button>
 <button class="pp-sv-btn" data-svhl="1">${ICON.star} Highlight</button>
 <button class="pp-sv-btn danger" data-svdel="1">${ICON.trash}</button>
 </div>`
 : `<div class="pp-sv-reply-bar">
 <input class="pp-sv-reply-input" placeholder="ตอบ ${esc(storyAuthorLabel(s))}…">
 <button class="pp-sv-like${liked ? ' on' : ''}" data-svlike="1">${liked ? ICON.heart : ICON.heartOut}</button>
 </div>`;
 v.innerHTML = `<div class="pp-sv-bars">${bars}</div>
 <div class="pp-sv-top">
 <div class="pp-sv-who">${avHTML(avatar, storyAuthorLabel(s)[0], 32)}
 <span class="pp-sv-name">${esc(storyAuthorLabel(s))}</span>
 <span class="pp-sv-age">${esc(fmtNoteAge(s.ts))}</span>
 ${s.closeOnly ? `<span class="pp-sv-age">${ICON.users}</span>` : ''}</div>
 <div class="pp-sv-tools">
 <button data-svpause="1">${ppStoryPaused ? ICON.play : ICON.pause}</button>
 <button data-svclose="1">${ICON.close}</button>
 </div>
 </div>
 <div class="pp-sv-body">${body}</div>
 <button class="pp-sv-tap prev" data-svprev="1"></button>
 <button class="pp-sv-tap next" data-svnext="1"></button>
 ${footer}
 <div class="pp-sv-viewers" id="pp-sv-viewers">
 <div class="pp-sv-grab"></div>
 <div class="pp-sv-viewers-head"><span>ผู้ชม</span><button class="pp-nav-action" data-svviewclose="1">${ICON.close}</button></div>
 <div class="pp-sv-viewers-list" id="pp-sv-viewers-list"></div>
 </div>`;
 if (s.type === 'image') {
 const el = document.getElementById('pp-sv-img');
 loadMedia('story-' + s.id).then(img => { if (el && img) el.style.backgroundImage = `url(${img})`; startStoryTimer(s); }).catch(() => startStoryTimer(s));
 } else startStoryTimer(s);

 v.querySelector('[data-svclose]')?.addEventListener('click', closeStoryViewer);
 v.querySelector('[data-svprev]')?.addEventListener('click', storyPrev);
 v.querySelector('[data-svnext]')?.addEventListener('click', storyNext);
 v.querySelector('[data-svpause]')?.addEventListener('click', () => {
 ppStoryPaused = !ppStoryPaused;
 if (ppStoryPaused) { clearTimeout(ppStoryTimer); const b = v.querySelector('.pp-sv-bar i.active'); if (b) b.style.animationPlayState = 'paused'; }
 else startStoryTimer(s);
 const btn = v.querySelector('[data-svpause]');
 if (btn) btn.innerHTML = ppStoryPaused ? ICON.play : ICON.pause;
 });
 v.querySelector('[data-svdel]')?.addEventListener('click', () => deleteStory(s.id));
 v.querySelector('[data-svlike]')?.addEventListener('click', () => { toggleStoryLike(s); renderStoryViewer(); });
 v.querySelector('[data-svhl]')?.addEventListener('click', () => addStoryHighlight(s));
 v.querySelector('[data-svviewers]')?.addEventListener('click', () => showStoryViewers(s));
 v.querySelector('[data-svviewclose]')?.addEventListener('click', () => document.getElementById('pp-sv-viewers')?.classList.remove('show'));
 const ri = v.querySelector('.pp-sv-reply-input');
 if (ri) {
 ri.addEventListener('focus', () => { clearTimeout(ppStoryTimer); ppStoryPaused = true; });
 ri.addEventListener('keydown', e => { if (e.key === 'Enter') { const t = ri.value.trim(); if (t) storyReply(s, t); } });
 }
 // double-tap like
 const bodyEl = v.querySelector('.pp-sv-body');
 if (bodyEl && !isUser) {
 let lastTap = 0;
 bodyEl.addEventListener('click', () => {
 const now = Date.now();
 if (now - lastTap < 320) { if (!(s.likes || []).includes('user')) { toggleStoryLike(s); renderStoryViewer(); } }
 lastTap = now;
 });
 }
}
function storyNext() { if (!ppStoryView) return; ppStoryView.idx++; if (ppStoryView.idx >= ppStoryView.list.length) { closeStoryViewer(); return; } renderStoryViewer(); }
function storyPrev() { if (!ppStoryView) return; if (ppStoryView.idx <= 0) return; ppStoryView.idx--; renderStoryViewer(); }
function closeStoryViewer() {
 clearTimeout(ppStoryTimer);
 ppStoryView = null; ppStoryPaused = false;
 const v = document.getElementById('pp-story-viewer');
 if (v) { v.style.display = 'none'; v.innerHTML = ''; }
 if (ppCurrentScreen === 'feed') renderFeed();
}
function toggleStoryLike(s) {
 const story = (getCfg().stories || []).find(x => x.id === s.id);
 if (!story) return;
 if (!story.likes) story.likes = [];
 const i = story.likes.indexOf('user');
 if (i >= 0) { story.likes.splice(i, 1); ppLog('story', `เลิกถูกใจสตอรี่ของ ${storyAuthorLabel(story)}`); }
 else { story.likes.push('user'); ppLog('story', `กดถูกใจสตอรี่ของ ${storyAuthorLabel(story)}${story.text ? ` ("${String(story.text).slice(0, 50)}")` : ''}`); }
 saveCfg();
 s.likes = story.likes;
}
function storyReply(s, text) {
 const c = findContact(s.author);
 if (!c) { ppToast('ตอบสตอรี่นี้ไม่ได้'); return; }
 const quoted = s.type === 'image' ? (s.text || '[รูปสตอรี่]') : s.text;
 pushThreadMsg(c.id, { from: 'me', text, replyTo: { kind: 'story', text: quoted, author: dname(c) } });
 ppLog('story', `ตอบสตอรี่ของ ${dname(c)}`, [`สตอรี่: "${String(quoted).slice(0, 60)}"`, `ตอบว่า: "${text}"`]);
 closeStoryViewer();
 ppActiveContact = c; ppActiveGroup = null;
 ppNav('chat');
 ppToast('ส่งคำตอบแล้ว');
}
function deleteStory(id) {
 const cfg = getCfg();
 const s = (cfg.stories || []).find(x => x.id === id);
 cfg.stories = (cfg.stories || []).filter(x => x.id !== id);
 delMedia('story-' + id);
 saveCfg();
 ppLog('story', `ลบสตอรี่ของตัวเอง${s && s.text ? ` ("${String(s.text).slice(0, 40)}")` : ''}`);
 closeStoryViewer();
 ppToast('ลบสตอรี่แล้ว');
}
function showStoryViewers(s) {
 const panel = document.getElementById('pp-sv-viewers');
 const list = document.getElementById('pp-sv-viewers-list');
 if (!panel || !list) return;
 const ids = Object.keys(s.views || {});
 list.innerHTML = ids.length
 ? ids.map(cid => {
 const ghost = String(cid).startsWith('ghost:');
 const nm = ghost ? String(cid).slice(6) : cname(cid);
 const c = ghost ? null : findContact(cid);
 const liked = (s.likes || []).includes(cid);
 return `<div class="pp-row">${avHTML(c ? c.avatar : '', nm[0], 42)}
 <div class="pp-row-meta"><div class="pp-row-name">${esc(nm)}${ghost ? '<span class="pp-ghost-badge">คนแปลกหน้า</span>' : ''}</div></div>
 ${liked ? `<span style="color:#ff375f">${ICON.heart}</span>` : ''}</div>`;
 }).join('')
 : `<div class="pp-empty">${ICON.eye}<br>ยังไม่มีใครดู</div>`;
 panel.classList.add('show');
 clearTimeout(ppStoryTimer);
 ppStoryPaused = true;
}
function addStoryHighlight(s) {
 const cfg = getCfg();
 const hls = cfg.storyHighlights || [];
 const items = hls.map(h => ({ label: `เพิ่มเข้า "${h.name}"`, icon: ICON.star, onClick: () => {
 if (!h.storyIds.includes(s.id)) h.storyIds.push(s.id);
 saveCfg();
 ppLogMinor('story', `เพิ่มสตอรี่เข้า Highlight "${h.name}"`);
 ppToast('เพิ่มแล้ว');
 } }));
 items.push({ label: 'สร้าง Highlight ใหม่', icon: ICON.plus, onClick: () => {
 ppPrompt('ชื่อ Highlight', '', name => {
 if (!name) return;
 cfg.storyHighlights.push({ id: newId(), name: name.slice(0, 24), storyIds: [s.id], ts: Date.now() });
 saveCfg();
 ppLog('story', `สร้าง Highlight "${name}" จากสตอรี่`);
 ppToast('สร้างแล้ว');
 }, { rows: 1 });
 } });
 ppSheet('เก็บเข้า Highlight', items);
}
function openHighlight(hid) {
 const h = (getCfg().storyHighlights || []).find(x => x.id === hid);
 if (!h) return;
 const list = getStories().filter(s => (h.storyIds || []).includes(s.id));
 if (!list.length) { ppToast('Highlight นี้ว่าง'); return; }
 ppStoryView = { list, idx: 0, author: 'user' };
 ppStoryPaused = false;
 const v = document.getElementById('pp-story-viewer');
 if (v) { v.style.display = 'block'; renderStoryViewer(); }
}

window.PP_LOADED = 'parsed-3.5of4';
console.log(`[pocket-phone] ${PP_VERSION} ท่อน 3.5/4 พร้อม - ฟีด 4 แท็บ + โปรไฟล์ + สตอรี่`);

// pocket-phone/index.js — 0.9.9 — ท่อน 4/4 (Wallet + ประจำเดือน + ตั้งค่า + เจน + bridge + boot)
// ต่อจากท่อน 3.5/4 ที่จบตรง window.PP_LOADED = 'parsed-3.5of4'
// ⚠️ ต้องแปะครบ 4 ท่อน (1 → 2 → 3 → 3.5 → 4) + manifest มี generate_interceptor:"ppGenInterceptor"

// ══════════════════════════════════════════════════════════
// WALLET
// ══════════════════════════════════════════════════════════
function renderWallet() {
 ensureWalletAccount();
 const body = document.getElementById('pp-wallet-body');
 if (!body) return;
 document.querySelectorAll('#pp-wallet-seg button').forEach(b => b.classList.toggle('on', b.dataset.wtab === ppWalletTab));
 const cfg = getCfg();
 if (ppWalletTab === 'overview') renderWalletOverview(body, cfg);
 else if (ppWalletTab === 'transfer') renderWalletTransfer(body, cfg);
 else if (ppWalletTab === 'history') renderWalletHistory(body, cfg);
 else renderWalletSettings(body, cfg);
}
function walletCardHTML(cfg) {
 const buckets = walletDaysBuckets(7);
 const wk = buckets.reduce((a, b) => a + b.inSum - b.outSum, 0);
 return `<div class="pp-wcard">
 <div class="pp-wcard-top"><span class="pp-wcard-lb">Pocket Wallet</span>${ICON.money}</div>
 <div class="pp-wcard-bal">${esc(fmtMoney(walletBalanceGet()))}</div>
 <div class="pp-wcard-chg">${wk >= 0 ? ICON.arrowIn : ICON.arrowOut}
 <span>7 วันนี้ ${wk >= 0 ? '+' : '-'}${esc(fmtMoney(Math.abs(wk)))}</span></div>
 <div class="pp-wcard-foot">
 <span>${esc(walletName())}</span>
 <span class="pp-wcard-acc">${esc(cfg.walletAccount)}</span>
 </div>
 </div>`;
}
function renderWalletOverview(body, cfg) {
 const buckets = walletDaysBuckets(7);
 const max = Math.max(1, ...buckets.map(b => Math.max(b.inSum, b.outSum)));
 const bars = buckets.map(b => {
 const ih = Math.round(b.inSum / max * 68);
 const oh = Math.round(b.outSum / max * 68);
 return `<div class="pp-wbar"><div class="pp-wbar-stack">
 ${b.inSum ? `<div class="pp-wbar-in" style="height:${ih}px"></div>` : ''}
 ${b.outSum ? `<div class="pp-wbar-out" style="height:${oh}px"></div>` : ''}
 </div><span class="pp-wbar-lb">${b.label}</span></div>`;
 }).join('');
 const hist = walletHistoryArr().slice(-5).reverse();
 const reqs = (cfg.walletRequests || []).filter(r => r.status === 'pending');
 const spent = spentToday();
 const lim = cfg.walletDailyLimit || 0;
 body.innerHTML = `${walletCardHTML(cfg)}
 <div class="pp-wacts">
 <button class="pp-wact" id="pp-w-send">${ICON.transfer}<span>โอน</span></button>
 <button class="pp-wact" id="pp-w-request">${ICON.arrowIn}<span>ขอเงิน</span></button>
 <button class="pp-wact" id="pp-w-topup">${ICON.plus}<span>เติม</span></button>
 <button class="pp-wact" id="pp-w-deduct">${ICON.minus}<span>หัก</span></button>
 </div>
 <div class="pp-hint" style="margin:0 2px 10px">ขอเงินจะส่งข้อความเข้าแชทคนนั้น พร้อมจำนวนและข้อความที่คุณเขียนเอง</div>
 ${lim ? `<div class="pp-card"><div class="pp-cell"><span class="pp-cell-lb">${ICON.chart} ใช้วันนี้</span>
 <span class="pp-cell-val">${esc(fmtMoney(spent))} / ${esc(fmtMoney(lim))}</span></div></div>` : ''}
 ${reqs.length ? `<div class="pp-sec-label">คำขอเงินที่ค้าง</div>
 <div class="pp-card">${reqs.map(r => `<div class="pp-cell">
 <span class="pp-cell-lb">${ICON.arrowIn} ขอ ${esc(fmtMoney(r.amount))} จาก ${esc(cname(r.cid))}</span>
 <span class="pp-cell-val">${esc(fmtNoteAge(r.ts))}</span></div>`).join('')}</div>` : ''}
 <div class="pp-wchart">
 <div class="pp-wchart-head"><span>${ICON.chart} รายรับรายจ่าย 7 วัน</span></div>
 <div class="pp-wchart-bars">${bars}</div>
 <div class="pp-wlegend"><span><i style="background:#30d158"></i>เข้า</span><span><i style="background:#ff375f"></i>ออก</span></div>
 </div>
 <div class="pp-sec-label">รายการล่าสุด</div>
 ${hist.length ? `<div class="pp-whist">${hist.map(walletRowHTML).join('')}</div>`
 : `<div class="pp-empty">${ICON.money}<br>ยังไม่มีรายการ</div>`}`;
}
function walletRowHTML(h) {
 const inn = h.dir === 'in';
 return `<div class="pp-wrow">
 <span class="pp-wic ${inn ? 'in' : 'out'}">${inn ? ICON.arrowIn : ICON.arrowOut}</span>
 <div class="pp-wrow-meta">
 <div class="pp-wrow-name">${esc(h.name || (inn ? 'รับเข้า' : 'จ่ายออก'))}</div>
 <div class="pp-wrow-sub">${esc(h.note || '')}${h.note ? ' · ' : ''}${esc(fmtListTime(h.ts))} ${esc(fmtHM(new Date(h.ts)))}</div>
 </div>
 <span class="pp-wamt ${inn ? 'in' : 'out'}">${inn ? '+' : '-'}${esc(fmtMoney(h.amount))}</span>
 </div>`;
}
function renderWalletTransfer(body, cfg) {
 const contacts = getContacts().filter(c => !isBlocked(c.id));
 body.innerHTML = `${walletCardHTML(cfg)}
 <div class="pp-sec-label">โอนให้คนคุย</div>
 ${contacts.length ? `<div class="pp-whist">${contacts.map(c => `<div class="pp-wbot">
 ${contactAvatarHTML(c, 40)}
 <div class="pp-wrow-meta"><div class="pp-wrow-name">${esc(dname(c))}</div>
 <div class="pp-wrow-sub">ยอดของเขา ${esc(fmtMoney(getBotWallet(c.id)))}</div></div>
 <span style="display:flex;gap:6px">
 <button class="pp-btn primary" data-wsend="${esc(c.id)}" style="padding:7px 12px">โอน</button>
 <button class="pp-btn" data-wreq="${esc(c.id)}" style="padding:7px 12px">ขอ</button>
 </span></div>`).join('')}</div>`
 : `<div class="pp-empty">${ICON.users}<br>ยังไม่มีคนคุย</div>`}
 <div class="pp-hint">การโอนจะขึ้นเป็นการ์ดในแชทและเข้าบันทึกกิจกรรมที่บอทในบทหลักรับรู้</div>`;
}
function renderWalletHistory(body, cfg) {
 const hist = walletHistoryArr().slice().reverse();
 if (!hist.length) { body.innerHTML = `<div class="pp-empty">${ICON.money}<br>ยังไม่มีรายการ</div>`; return; }
 const byDay = {};
 hist.forEach(h => {
 const k = ymd(new Date(h.ts));
 if (!byDay[k]) byDay[k] = [];
 byDay[k].push(h);
 });
 const today = ymd(new Date());
 const yst = new Date(); yst.setDate(yst.getDate() - 1);
 const ystKey = ymd(yst);
 body.innerHTML = `<div class="pp-whist">${Object.keys(byDay).map(k => {
 const label = k === today ? 'วันนี้' : k === ystKey ? 'เมื่อวาน' : ymdLabel(k);
 const rows = byDay[k];
 const sumIn = rows.filter(r => r.dir === 'in').reduce((a, r) => a + r.amount, 0);
 const sumOut = rows.filter(r => r.dir === 'out').reduce((a, r) => a + r.amount, 0);
 return `<div class="pp-whist-day">${esc(label)} · เข้า ${esc(fmtMoney(sumIn))} · ออก ${esc(fmtMoney(sumOut))}</div>`
 + rows.map(walletRowHTML).join('');
 }).join('')}</div>`;
}
function renderWalletSettings(body, cfg) {
 body.innerHTML = `
 <div class="pp-sec-label">บัญชี</div>
 <div class="pp-card">
 <div class="pp-cell tap" id="pp-w-name"><span class="pp-cell-lb">${ICON.person} ชื่อบัญชี</span>
 <span class="pp-cell-val">${esc(walletName())}${ICON.chevron}</span></div>
 <div class="pp-cell tap" id="pp-w-acc"><span class="pp-cell-lb">${ICON.card} เลขบัญชี</span>
 <span class="pp-cell-val">${esc(cfg.walletAccount)}${ICON.chevron}</span></div>
 <div class="pp-cell"><span class="pp-cell-lb">${ICON.money} สกุลเงิน</span>
 <select class="pp-sel" id="pp-w-cur">
 ${PP_CURRENCIES.map(x => `<option value="${x}"${cfg.walletCurrency === x ? ' selected' : ''}>${x}${x === '₩' ? ' (วอน)' : x === '฿' ? ' (บาท)' : ''}</option>`).join('')}
 </select></div>
 <div class="pp-cell"><span class="pp-cell-lb">${ICON.messages} แยกกระเป๋าเงินตามแชท</span>
 <label class="pp-switch"><input type="checkbox" id="pp-w-perchat"${cfg.walletPerChat ? ' checked' : ''}><span></span></label></div>
 <div class="pp-cell"><span class="pp-cell-lb">${ICON.chart} ลิมิตต่อวัน (0 = ไม่จำกัด)</span>
 <input class="pp-num" type="number" id="pp-w-limit" min="0" value="${cfg.walletDailyLimit || 0}"></div>
 </div>
 <div class="pp-sec-label">ยอดเงินของบอท</div>
 <div class="pp-whist">${getContacts().map(c => `<div class="pp-wbot">
 ${contactAvatarHTML(c, 36)}
 <div class="pp-wrow-meta"><div class="pp-wrow-name">${esc(dname(c))}</div></div>
 <span class="pp-wbot-bal">${esc(fmtMoney(getBotWallet(c.id)))}</span>
 <button class="pp-btn" data-wbotedit="${esc(c.id)}" style="padding:6px 11px">แก้</button>
 </div>`).join('') || `<div class="pp-empty">ยังไม่มีคนคุย</div>`}</div>
 ${cfg.walletPerChat ? `<div class="pp-hint">กระเป๋าเงินนี้เป็นของรูท <b>${esc(walletRouteKey())}</b> — สลับแชทใน SillyTavern แล้วยอดเงินจะเปลี่ยนตาม</div>` : ''}
 <div class="pp-sec-label">อื่น ๆ</div>
 <div class="pp-card">
 <div class="pp-cell tap" id="pp-w-reset"><span class="pp-cell-lb">${ICON.trash} ล้างประวัติธุรกรรม</span>
 <span class="pp-cell-val">${walletHistoryArr().length} รายการ${ICON.chevron}</span></div>
 </div>`;
}
function ppWalletMenu() {
 ppSheet('กระเป๋าเงิน', [
 { label: 'เติมยอด', icon: ICON.plus, onClick: ppWalletTopup },
 { label: 'หักยอด', icon: ICON.minus, onClick: ppWalletDeduct },
 { label: 'ขอเงินจากบอท', icon: ICON.arrowIn, onClick: ppWalletRequest },
 { label: 'ตั้งค่าบัญชี', icon: ICON.gear, onClick: () => { ppWalletTab = 'settings'; renderWallet(); } },
 ]);
}
function ppWalletTopup() {
 ppPrompt('เติมเท่าไหร่', '', v => {
 const n = Math.abs(parseInt(String(v).replace(/[^\d]/g, ''), 10) || 0);
 if (!n) return;
 ppPrompt('มาจากอะไร (ไม่บังคับ)', '', reason => {
 adjustUserBalance(n);
 pushWalletHistory('in', n, null, reason || 'ปรับยอดเอง', 'เติมเงิน');
 ppLog('wallet', `เติมเงินเข้ากระเป๋า ${fmtMoney(n)}${reason ? ` (${reason})` : ''}`, [`ยอดคงเหลือ ${fmtMoney(getCfg().walletBalance)}`]);
 renderWallet(); updateHomeWidgets();
 ppToast(`+${fmtMoney(n)}`);
 }, { rows: 1, placeholder: 'เช่น เงินเดือน' });
 }, { rows: 1 });
}
function ppWalletDeduct() {
 ppPrompt('หักเท่าไหร่', '', v => {
 const n = Math.abs(parseInt(String(v).replace(/[^\d]/g, ''), 10) || 0);
 if (!n) return;
 ppPrompt('ใช้ไปกับอะไร (ไม่บังคับ)', '', reason => {
 adjustUserBalance(-n);
 pushWalletHistory('out', n, null, reason || 'ปรับยอดเอง', 'หักเงิน');
 ppLog('wallet', `ใช้เงิน ${fmtMoney(n)}${reason ? ` ไปกับ "${reason}"` : ''}`, [`ยอดคงเหลือ ${fmtMoney(getCfg().walletBalance)}`]);
 renderWallet(); updateHomeWidgets();
 ppToast(`-${fmtMoney(n)}`);
 }, { rows: 1, placeholder: 'เช่น ค่ากาแฟ' });
 }, { rows: 1 });
}
function ppWalletRequest(cid) {
 const ask = target => {
 ppPrompt(`ขอเงินจาก ${cname(target)} เท่าไหร่`, '', v => {
 const n = Math.abs(parseInt(String(v).replace(/[^\d]/g, ''), 10) || 0);
 if (!n) return;
 ppPrompt('เหตุผล (ไม่บังคับ)', '', reason => {
 const cfg = getCfg();
 cfg.walletRequests.push({ id: newId(), cid: target, amount: n, note: reason, status: 'pending', ts: Date.now() });
 saveCfg();
 pushThreadMsg(target, { from: 'me', text: `ขอยืมเงิน ${fmtMoney(n)}${reason ? ` — ${reason}` : ''} ได้ไหม` });
 ppLog('wallet', `ขอเงิน ${fmtMoney(n)} จาก ${cname(target)}${reason ? ` เหตุผล "${reason}"` : ''}`);
 ppActiveContact = findContact(target); ppActiveGroup = null;
 ppNav('chat');
 ppToast('ส่งคำขอแล้ว');
 }, { rows: 2 });
 }, { rows: 1 });
 };
 if (cid) ask(cid);
 else ppPickContact('ขอเงินจากใคร', ask, null, { compact: true, subLabel: c => fmtMoney(getBotWallet(c.id)) });
}

// ══════════════════════════════════════════════════════════
// PERIOD
// ══════════════════════════════════════════════════════════
const HELPER_SECTIONS = [
 ['ข้อความ', 'พิมพ์แล้วกดปุ่มเจน (ไอคอนดาว) ให้บอทตอบ · ปัดฟองไปขวาเพื่อตอบข้อความนั้น · แตะฟองเพื่อ ติดดาว/แก้ไข/ลบ/แชร์ · ปัดแถวแชทซ้ายเพื่อ ปักหมุด/ปิดเสียง/เก็บ/ลบ'],
 ['แชทกลุ่ม', 'ปุ่มรูปคนมุมขวาบนหน้าข้อความ → เลือกสมาชิก ≥2 คน · ตั้งได้ว่าสมาชิกรู้จักกันไหม และตอบทีละคนหรือหลายคน · กดเจนแล้วสมาชิกผลัดกันตอบ'],
 ['โทรศัพท์', 'ปุ่มโทรในหน้าแชท · ระหว่างสายพิมพ์แล้วกดปุ่มเจนให้อีกฝ่ายพูด · เวลาสายนับจากเวลาจริง · จบสายแล้วบทสนทนาถูกเก็บในประวัติการโทร'],
 ['สตอรี่', 'แตะวงกลมแรกในฟีดเพื่อลงสตอรี่ (รูป/ข้อความ) · เลือกได้ว่าให้ทุกคนหรือเฉพาะเพื่อนสนิทเห็น · อยู่ 24 ชม. เก็บเข้า Highlight ได้'],
 ['ฟีด', 'ปุ่มบวกสร้างโพสต์ · ปุ่มเจนบนขวาเลือกให้ใครโพสต์ · ในโพสต์กดเจนเพื่อเลือกบอท/สุ่มจํานวนมาคอมเมนต์ · ตั้งการมองเห็นต่อโพสต์ได้'],
 ['กระเป๋าเงิน', 'โอน/ขอ/เติม/หัก เงินได้ · การโอนขึ้นเป็นการ์ดในแชท · กราฟ 7 วันดูรายรับรายจ่าย · ตั้งลิมิตต่อวันและสกุลเงินได้'],
 ['ประจําเดือน', 'แตะวันในปฏิทินเพื่อทําเครื่องหมาย แตะซ้ําเพื่อบันทึกอาการ · ระบบคํานวณรอบเฉลี่ยและคาดการณ์ · เปิด/ปิดให้บอทรับรู้ได้ที่แท็บความเป็นส่วนตัว'],
 ['สติกเกอร์', 'ตั้งค่า › สติกเกอร์ · เพิ่มชุดด้วยลิงก์รูป+ป้ายชื่อ · นําเข้า/ส่งออกเป็นไฟล์ JSON ได้ · บอทส่งได้โดยพิมพ์ [STICKER] ตามชื่อป้าย'],
 ['บันทึกกิจกรรม', 'ทุกอย่างที่คุณทําบนมือถือถูกเก็บเป็นคิว แล้วส่งเป็น system prompt ชั่วคราวในการเจนโรลเพลย์ครั้งถัดไป โดยไม่แก้ข้อความของคุณ · ดู/ล้างคิวได้ในตั้งค่า'],
 ['NPC สร้างเอง', 'หน้าเพิ่มคนคุย › "สร้าง NPC เอง" · ตั้งชื่อ บุคลิก และเลือกตัวละครหลักเป็นต้นแบบได้ · ใช้ตัวอักษรตัวแรกเป็นรูป'],
 ['ความเป็นส่วนตัว', 'ล็อคบัญชีให้บอทต้องขอติดตามก่อน · ตั้งค่าใครเห็นโพสต์ได้ · จัดการเพื่อนสนิท/จํากัด/บล็อก'],
 ['Dynamic Island', 'แถบบนสุดแสดงสถานะสด เช่น กําลังเจน กําลังโทร สายเข้า และข้อความใหม่ · เปิด/ปิดได้ในตั้งค่า'],
 ['เชื่อมกับเนื้อเรื่อง', 'เปิด "แทรกกิจกรรมเข้าบทหลัก" เพื่อให้บอทรู้สิ่งที่คุณทํา · เปิด "มีผลต่อโรลเพลย์หลัก" เพื่อให้บทหลักสั่งมือถือได้ (โทร/ข้อความ/โอน) และมือถือยึดบุคลิกจากโรล'],
 ['แก้ปัญหาเบื้องต้น', 'ซิงค์ไม่มา: ดูใบยืนยันผลในตั้งค่าและตรวจว่าเปิดอัปเดตอัตโนมัติ · เจนไม่ออก: PP_DIAG() ดูว่าเจอ API ไหม · รูปไม่ขึ้น: พื้นที่เก็บข้อมูลอาจเต็ม ลองรูปเล็กลง'],
];
function renderHelper() {
 const body = document.getElementById('pp-helper-body');
 if (!body) return;
 body.innerHTML = `<div class="pp-hint" style="margin:0 0 10px">คู่มือนี้อ่านได้เฉพาะในแอปนี้ ไม่ถูกส่งเข้า prompt ของบอทหรือเนื้อเรื่องใด ๆ</div>`
 + HELPER_SECTIONS.map(([t, d]) => `<div class="pp-sec-label">${esc(t)}</div>
 <div class="pp-card"><div class="pp-cell" style="white-space:normal;line-height:1.6">${esc(d)}</div></div>`).join('')
 + `<div class="pp-hint" style="text-align:center;padding:14px 0">Pocket Phone ${PP_VERSION}</div>`;
}
function renderPeriod() {
 const body = document.getElementById('pp-period-body');
 if (!body) return;
 document.querySelectorAll('#pp-period-seg button').forEach(b => b.classList.toggle('on', b.dataset.ptab === ppPeriodTab));
 if (ppPeriodTab === 'today') renderPeriodToday(body);
 else if (ppPeriodTab === 'calendar') renderPeriodCalendar(body);
 else if (ppPeriodTab === 'history') renderPeriodHistory(body);
 else renderPeriodPrivacy(body);
}
function renderPeriodToday(body) {
 const info = periodTodayInfo();
 const avg = info.avg;
 const today = ymd(new Date());
 const log = (getCfg().periodLogs || {})[today] || { flow: '', symptoms: [], mood: '', note: '' };
 const cycleLen = avg.cycleLen || 28;
 let dayNum, pct;
 if (info.onPeriod) { dayNum = info.dayNum; pct = Math.min(1, dayNum / (avg.duration || 5)); }
 else if (info.sinceStart != null) { dayNum = info.sinceStart + 1; pct = Math.min(1, dayNum / cycleLen); }
 else { dayNum = 0; pct = 0; }
 const R = 84, C = 2 * Math.PI * R;
 body.innerHTML = `
 <div class="pp-ring-wrap">
 <div class="pp-ring">
 <svg viewBox="0 0 196 196">
 <defs><linearGradient id="pp-ring-grad" x1="0" y1="0" x2="1" y2="1">
 <stop offset="0%" stop-color="#ff6482"/><stop offset="100%" stop-color="#ff375f"/>
 </linearGradient></defs>
 <circle class="pp-ring-bg" cx="98" cy="98" r="${R}"/>
 <circle class="pp-ring-fg" cx="98" cy="98" r="${R}" stroke-dasharray="${C}" stroke-dashoffset="${C * (1 - pct)}"/>
 </svg>
 <div class="pp-ring-mid">
 <div class="pp-ring-day">${dayNum || '—'}</div>
 <div class="pp-ring-lb">${info.onPeriod ? 'วันที่ของรอบ' : dayNum ? 'วันของวงจร' : 'ยังไม่มีข้อมูล'}</div>
 <div class="pp-ring-phase">${esc(phaseLabel(info.phase))}</div>
 </div>
 </div>
 </div>
 <div class="pp-pstats">
 <div class="pp-pstat"><b>${info.onPeriod ? 'วันนี้' : (info.upcomingIn != null && info.upcomingIn >= 0 ? info.upcomingIn : '—')}</b>
 <span>${info.onPeriod ? 'มีประจำเดือน' : 'วันถึงรอบถัดไป'}</span></div>
 <div class="pp-pstat"><b>${cycleLen}</b><span>ความยาวรอบเฉลี่ย</span></div>
 <div class="pp-pstat"><b>${avg.duration || 5}</b><span>วันเฉลี่ยที่มา</span></div>
 </div>
 <button class="pp-btn ${isPeriodDay(today) ? '' : 'primary'} wide" id="pp-p-marktoday">
 ${isPeriodDay(today) ? ICON.close + 'ยกเลิกเครื่องหมายวันนี้' : ICON.drop + 'บันทึกว่าประจำเดือนมาวันนี้'}</button>

 <div class="pp-sec-label">บันทึกวันนี้</div>
 <div class="pp-card">
 <div class="pp-cell pp-cell-col">
 <div class="pp-cell-lb" style="margin-bottom:8px">ปริมาณ</div>
 <div class="pp-tags-pick">${PERIOD_FLOWS.map(f =>
 `<button class="pp-tag-btn${log.flow === f ? ' on' : ''}" data-pflow="${esc(f)}">${esc(f)}</button>`).join('')}</div>
 </div>
 <div class="pp-cell pp-cell-col">
 <div class="pp-cell-lb" style="margin-bottom:8px">อาการ</div>
 <div class="pp-tags-pick">${PERIOD_SYMPTOMS.map(s =>
 `<button class="pp-tag-btn${(log.symptoms || []).includes(s) ? ' on' : ''}" data-psym="${esc(s)}">${esc(s)}</button>`).join('')}</div>
 </div>
 <div class="pp-cell pp-cell-col">
 <div class="pp-cell-lb" style="margin-bottom:8px">อารมณ์</div>
 <div class="pp-tags-pick">${PERIOD_MOODS.map(m =>
 `<button class="pp-tag-btn${log.mood === m ? ' on' : ''}" data-pmood="${esc(m)}">${esc(m)}</button>`).join('')}</div>
 </div>
 </div>
 <div class="pp-sec-label">โน้ต</div>
 <textarea class="pp-input-line" id="pp-p-note" rows="3" placeholder="อยากบันทึกอะไรเพิ่ม">${esc(log.note || '')}</textarea>
 <button class="pp-btn wide" id="pp-p-savenote" style="margin-top:8px">บันทึกโน้ต</button>`;
}
function renderPeriodCalendar(body) {
 const y = ppCalMonth.getFullYear(), mo = ppCalMonth.getMonth();
 const first = new Date(y, mo, 1).getDay();
 const days = new Date(y, mo + 1, 0).getDate();
 const todayStr = ymd(new Date());
 const pred = periodPredicted();
 const ovu = periodOvulationDays();
 let cells = '';
 for (let i = 0; i < first; i++) cells += `<span class="pp-cal-cell empty"></span>`;
 for (let d = 1; d <= days; d++) {
 const sd = `${y}-${String(mo + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
 const cls = [
 isPeriodDay(sd) ? 'on' : '',
 sd === todayStr ? 'today' : '',
 !isPeriodDay(sd) && pred.includes(sd) ? 'pred' : '',
 !isPeriodDay(sd) && ovu.includes(sd) ? 'ovu' : '',
 ].filter(Boolean).join(' ');
 cells += `<button class="pp-cal-cell ${cls}" data-calday="${sd}">${d}${hasPeriodLog(sd) ? '<span class="pp-cal-dot"></span>' : ''}</button>`;
 }
 body.innerHTML = `
 <div class="pp-cal-head">
 <button class="pp-cal-nav" id="pp-cal-prev">${ICON.back}</button>
 <b>${TH_MONTHS_FULL[mo]} ${y}</b>
 <button class="pp-cal-nav" id="pp-cal-next">${ICON.fwd}</button>
 </div>
 <div class="pp-cal-dow"><span>อา</span><span>จ</span><span>อ</span><span>พ</span><span>พฤ</span><span>ศ</span><span>ส</span></div>
 <div class="pp-cal-grid" id="pp-cal-grid">${cells}</div>
 <div class="pp-cal-legend">
 <span><i style="background:#ff375f"></i>มีประจำเดือน</span>
 <span><i style="box-shadow:inset 0 0 0 1.5px rgba(255,100,130,.7)"></i>คาดการณ์</span>
 <span><i style="box-shadow:inset 0 0 0 1.5px rgba(50,173,230,.7)"></i>ไข่ตก</span>
 <span><i style="background:var(--pp-txt3);width:5px;height:5px"></i>มีบันทึกอาการ</span>
 </div>
 <div class="pp-hint">แตะวันเพื่อทำเครื่องหมาย · แตะซ้ำเพื่อบันทึกอาการของวันนั้น</div>`;
 bindCalSwipe(body);
}
function bindCalSwipe(root) {
 const grid = root.querySelector('#pp-cal-grid');
 if (!grid) return;
 let x0 = 0, active = false;
 grid.addEventListener('touchstart', e => { x0 = e.touches[0].clientX; active = false; }, { passive: true });
 grid.addEventListener('touchmove', e => { if (Math.abs(e.touches[0].clientX - x0) > 40) active = true; }, { passive: true });
 grid.addEventListener('touchend', e => {
 if (!active) return;
 const dx = e.changedTouches[0].clientX - x0;
 ppCalNav(dx > 0 ? -1 : 1);
 }, { passive: true });
}
function ppCalNav(delta) {
 ppCalMonth = new Date(ppCalMonth.getFullYear(), ppCalMonth.getMonth() + delta, 1);
 renderPeriod();
}
function renderPeriodHistory(body) {
 const cycles = periodCycles().slice().reverse();
 const avg = periodAvg();
 if (!cycles.length) { body.innerHTML = `<div class="pp-empty">${ICON.calendar}<br>ยังไม่มีประวัติรอบ<span>ทำเครื่องหมายวันในปฏิทินก่อน</span></div>`; return; }
 const notes = [];
 if (cycles.length >= 2) {
 const gap = Math.round((new Date(cycles[0].start) - new Date(cycles[1].start)) / 86400000);
 const diff = gap - avg.cycleLen;
 if (Math.abs(diff) <= 2) notes.push('รอบของคุณค่อนข้างสม่ำเสมอ');
 else if (diff > 0) notes.push(`รอบล่าสุดยาวกว่าค่าเฉลี่ย ${diff} วัน`);
 else notes.push(`รอบล่าสุดสั้นกว่าค่าเฉลี่ย ${Math.abs(diff)} วัน`);
 }
 if (cycles[0] && avg.duration && cycles[0].len > avg.duration + 2) notes.push('รอบล่าสุดมานานกว่าปกติ');
 body.innerHTML = `
 <div class="pp-pstats">
 <div class="pp-pstat"><b>${cycles.length}</b><span>รอบที่บันทึก</span></div>
 <div class="pp-pstat"><b>${avg.cycleLen}</b><span>ความยาวรอบเฉลี่ย</span></div>
 <div class="pp-pstat"><b>${avg.duration}</b><span>วันเฉลี่ยที่มา</span></div>
 </div>
 ${notes.length ? `<div class="pp-card"><div class="pp-cell pp-cell-col">
 <div class="pp-cell-lb" style="margin-bottom:6px">${ICON.chart} วิเคราะห์</div>
 ${notes.map(n => `<div class="pp-hint" style="margin:0 0 4px">${esc(n)}</div>`).join('')}
 </div></div>` : ''}
 <div class="pp-sec-label">รอบย้อนหลัง</div>
 <div class="pp-card">${cycles.map((cy, i) => {
 const prev = cycles[i + 1];
 const gap = prev ? Math.round((new Date(cy.start) - new Date(prev.start)) / 86400000) : null;
 return `<div class="pp-cyclerow">
 <span class="pp-cycle-ic">${ICON.drop}</span>
 <div class="pp-wrow-meta">
 <div class="pp-wrow-name">${esc(ymdLabel(cy.start))}${cy.len > 1 ? ` - ${esc(ymdLabel(cy.end))}` : ''}</div>
 <div class="pp-wrow-sub">มา ${cy.len} วัน${gap ? ` · ห่างรอบก่อน ${gap} วัน` : ''}</div>
 </div>
 </div>`;
 }).join('')}</div>`;
}
function renderPeriodPrivacy(body) {
 const cfg = getCfg();
 const preview = periodPromptNote() || '(ปิดอยู่ หรือไม่มีข้อมูลจะส่ง)';
 body.innerHTML = `
 <div class="pp-sec-label">ให้บอทรู้ไหม</div>
 <div class="pp-card">
 <div class="pp-cell"><span class="pp-cell-lb">${ICON.eye} ให้บอทรับรู้รอบเดือน</span>
 <label class="pp-switch"><input type="checkbox" id="pp-p-share"${cfg.periodShareBot ? ' checked' : ''}><span></span></label></div>
 <div class="pp-cell"><span class="pp-cell-lb">ระดับความใส่ใจ</span>
 <select class="pp-sel" id="pp-p-care">
 <option value="light"${cfg.periodCareLevel === 'light' ? ' selected' : ''}>แค่รู้ไว้</option>
 <option value="normal"${cfg.periodCareLevel === 'normal' ? ' selected' : ''}>ปกติ</option>
 <option value="high"${cfg.periodCareLevel === 'high' ? ' selected' : ''}>ใส่ใจมาก</option>
 </select></div>
 <div class="pp-cell tap" id="pp-p-who"><span class="pp-cell-lb">${ICON.users} ให้ใครรู้</span>
 <span class="pp-cell-val">${Array.isArray(cfg.periodSharedWith) ? `${cfg.periodSharedWith.length} คน` : 'ทุกคน'}${ICON.chevron}</span></div>
 </div>
 <div class="pp-sec-label">ค่าเริ่มต้นของรอบ</div>
 <div class="pp-card">
 <div class="pp-cell"><span class="pp-cell-lb">ความยาวรอบ (วัน)</span>
 <input class="pp-num" type="number" id="pp-p-cyclelen" min="15" max="60" value="${cfg.periodCycleLen || 28}"></div>
 <div class="pp-cell"><span class="pp-cell-lb">ระยะเวลาที่มา (วัน)</span>
 <input class="pp-num" type="number" id="pp-p-dur" min="1" max="14" value="${cfg.periodDuration || 5}"></div>
 </div>
 <div class="pp-hint">ใช้เมื่อยังไม่มีข้อมูลพอคำนวณค่าเฉลี่ย</div>
 <div class="pp-sec-label">${ICON.eye} ข้อความที่บอทเห็นจริง</div>
 <div class="pp-promptbox">${esc(preview)}</div>
 <div class="pp-hint">ข้อความนี้ถูกฉีดเข้า prompt ใหม่ทุกครั้งที่บอทตอบ ไม่เขียนลงไฟล์แชท ค่าจึงถูกต้องเสมอ ส่วนการกดทำเครื่องหมายวันจะเข้าบันทึกกิจกรรมครั้งเดียว</div>
 <div class="pp-sec-label">อื่น ๆ</div>
 <div class="pp-card"><div class="pp-cell tap" id="pp-p-reset">
 <span class="pp-cell-lb">${ICON.trash} ล้างข้อมูลรอบเดือนทั้งหมด</span><span class="pp-cell-val">${ICON.chevron}</span></div></div>`;
}
function ppPeriodDayTap(sd) {
 if (isPeriodDay(sd) || hasPeriodLog(sd)) {
 ppPeriodDay = sd;
 ppPeriodLogSheet(sd);
 } else {
 togglePeriodDay(sd);
 renderPeriod();
 updateHomeWidgets();
 }
}
function ppPeriodLogSheet(sd) {
 const log = getPeriodLog(sd);
 const items = [
 { label: isPeriodDay(sd) ? 'ยกเลิกเครื่องหมายวันนี้' : 'ทำเครื่องหมายว่าประจำเดือนมา', icon: ICON.drop, onClick: () => { togglePeriodDay(sd); renderPeriod(); updateHomeWidgets(); } },
 { label: 'บันทึกปริมาณ', icon: ICON.chart, onClick: () => ppSheet('ปริมาณ', PERIOD_FLOWS.map(f => ({ label: f, onClick: () => { savePeriodLog(sd, { flow: f }); renderPeriod(); } }))) },
 { label: 'บันทึกอารมณ์', icon: ICON.person, onClick: () => ppSheet('อารมณ์', PERIOD_MOODS.map(m => ({ label: m, onClick: () => { savePeriodLog(sd, { mood: m }); renderPeriod(); } }))) },
 { label: 'บันทึกอาการ', icon: ICON.bell, onClick: () => ppMultiSelect({
 title: 'อาการ', selected: log.symptoms || [],
 items: PERIOD_SYMPTOMS.map(s => ({ id: s, label: s, avatar: '' })),
 onDone: arr => { savePeriodLog(sd, { symptoms: arr }); renderPeriod(); }
 }) },
 { label: 'เขียนโน้ต', icon: ICON.compose, onClick: () => ppPrompt(`โน้ตวันที่ ${ymdLabel(sd)}`, log.note || '', v => { savePeriodLog(sd, { note: v }); renderPeriod(); }) },
 ];
 ppSheet(ymdLabel(sd), items);
}

// ══════════════════════════════════════════════════════════
// SETTINGS / STICKER / LOG VIEW
// ══════════════════════════════════════════════════════════
function ppTokLabel(n) {
 const cache = getCfg().bridgeTokenCache;
 if (!cache || !cache.ok) return 'ยังไม่วัด';
 if (n == null) return '—';
 const v = Math.round(n);
 return v > 0 ? `${v} tok` : '0 tok';
}
function renderPhoneSettings() {
 const cfg = getCfg();
 const body = document.getElementById('pp-settings-body');
 if (!body) return;
 const personas = listUserPersonas();
 const cache = cfg.bridgeTokenCache || null;
 const measured = !!(cache && cache.ok);
 const tk = k => ppTokLabel(cache && cache.mods ? cache.mods[k] : null);
 const total = measured ? ppBridgeActiveTotal(cache) : null;
 const totalCnt = getContacts().filter(c => !isBlocked(c.id)).length;
 const modRow = m => `<div class="pp-cell">
 <span class="pp-cell-lb" style="flex-direction:column;align-items:flex-start;gap:2px">
 <span>${esc(m.label)}</span>
 <span style="font-size:11px;color:var(--pp-txt3);line-height:1.4">${esc(m.hint)}</span>
 </span>
 <span style="display:flex;align-items:center;gap:9px;flex-shrink:0">
 <span class="pp-tokchip${bridgeOn(m.key) ? ' on' : ''}">${tk(m.key)}</span>
 <label class="pp-switch"><input type="checkbox" data-bmod="${esc(m.key)}"${bridgeOn(m.key) ? ' checked' : ''}><span></span></label>
 </span>
 </div>`;
 const evRows = BRIDGE_MOD_META.filter(m => m.group === 'events').map(modRow).join('');
 const invRows = BRIDGE_MOD_META.filter(m => m.group === 'inv').map(modRow).join('');
 const cMode = cfg.contactSendMode || 'relevant';

 body.innerHTML = `
 <div class="pp-sec-label">${ICON.chart} โทเคนที่ส่งให้บอทต่อเทิร์น</div>
 <div class="pp-tokcard">
 <div class="pp-tokcard-top">
 <span class="pp-tokcard-lb">รวมที่เปิดอยู่</span>
 <span class="pp-tokcard-num" id="pp-tok-total">${measured ? `${total} tok` : 'ยังไม่วัด'}</span>
 </div>
 <div class="pp-tokcard-sub">${measured
  ? `นับด้วย${esc(cache.tokenizer)} · วัดเมื่อ ${esc(fmtNoteAge(cache.measuredAt))}`
  : `${esc((cache && cache.tokenizer) || 'ยังไม่ได้วัด')} — กดปุ่มวัดด้านล่าง`}</div>
 <div class="pp-tokcard-acts">
 <button class="pp-btn" id="pp-tok-remeasure">${measured ? 'วัดใหม่' : 'วัดเลย'}</button>
 <button class="pp-btn" data-bpreset="off">ปิดทั้งหมด</button>
 <button class="pp-btn primary" data-bpreset="need">เท่าที่จำเป็น</button>
 <button class="pp-btn" data-bpreset="all">เปิดทั้งหมด</button>
 </div>
 </div>
 <div class="pp-hint">ตัวเลขทุกตัวมาจากตัวนับของ SillyTavern เท่านั้น ไม่มีการประมาณ · ถ้าขึ้น "ยังไม่วัด" หมายถึงยังไม่ได้กดวัด หรือ ST นับไม่ได้ในเครื่องนี้ · แกนหลัก (${tk('core')}) ปิดไม่ได้เพราะเป็นตัวบอกรูปแบบข้อมูล</div>

 <div class="pp-sec-label">ประเภทเหตุการณ์ที่ให้เข้ามือถือ</div>
 <div class="pp-card">${evRows}</div>

 <div class="pp-sec-label">ข้อมูลอ้างอิงที่ส่งไปด้วย</div>
 <div class="pp-card">${invRows}</div>

 <div class="pp-sec-label">รายชื่อคอนแทกต์ที่ส่งไป (คุณมี ${totalCnt} คน)</div>
 <div class="pp-card">
 <button class="pp-persona-opt${cMode === 'off' ? ' on' : ''}" data-cmode="off">
 <span class="pp-persona-opt-lb">ไม่ส่งเลย · 0 tok<br><span style="font-size:11px;color:var(--pp-txt3)">ประหยัดสุด แต่บอทมักสะกดชื่อเพี้ยน</span></span>
 ${cMode === 'off' ? ICON.check : ''}</button>
 <button class="pp-persona-opt${cMode === 'relevant' ? ' on' : ''}" data-cmode="relevant">
 <span class="pp-persona-opt-lb">เฉพาะที่เกี่ยวข้องกับฉากนี้ · ${measured ? `${Math.round(cache.contactRelevant || 0)} tok` : 'ยังไม่วัด'}<br><span style="font-size:11px;color:var(--pp-txt3)">ตัวละครที่เปิดอยู่ + NPC ของเขา + คนที่คุยใน 7 วัน + คนปักหมุด</span></span>
 ${cMode === 'relevant' ? ICON.check : ''}</button>
 <button class="pp-persona-opt${cMode === 'all' ? ' on' : ''}" data-cmode="all">
 <span class="pp-persona-opt-lb">ทั้งหมด ${totalCnt} คน · ${measured ? `${Math.round(cache.contactAll || 0)} tok` : 'ยังไม่วัด'}<br><span style="font-size:11px;color:var(--pp-txt3)">คนที่มีบอทเยอะจะเปลืองมาก</span></span>
 ${cMode === 'all' ? ICON.check : ''}</button>
 ${cMode === 'relevant' ? `<div class="pp-cell"><span class="pp-cell-lb">ส่งกี่คน</span>
 <input class="pp-num" type="number" id="pp-set-climit" min="1" max="60" value="${cfg.contactSendLimit || 12}"></div>` : ''}
 </div>

 <div class="pp-sec-label">${ICON.users} สิ่งที่ยอมให้บอททำในมือถือคุณ</div>
 <div class="pp-card">
 <div class="pp-cell"><span class="pp-cell-lb" style="flex-direction:column;align-items:flex-start;gap:2px">
 <span>สร้างกลุ่มและดึงคุณเข้ากลุ่ม</span>
 <span style="font-size:11px;color:var(--pp-txt3)">บอทตั้งกลุ่มใหม่ ใส่ตัวเองกับคนอื่นเข้ามา แล้วเริ่มคุยได้เลย</span></span>
 <label class="pp-switch"><input type="checkbox" id="pp-set-botgroup"${cfg.botCanMakeGroup !== false ? ' checked' : ''}><span></span></label></div>
 <div class="pp-cell"><span class="pp-cell-lb" style="flex-direction:column;align-items:flex-start;gap:2px">
 <span>กำหนดยอดเงินของตัวเอง</span>
 <span style="font-size:11px;color:var(--pp-txt3)">เงินเดือนออก ถูกหวย หรือถังแตก — บอทบอกยอดตัวเองได้ตามเนื้อเรื่อง</span></span>
 <label class="pp-switch"><input type="checkbox" id="pp-set-botwallet"${cfg.botCanSetWallet !== false ? ' checked' : ''}><span></span></label></div>
 <div class="pp-cell"><span class="pp-cell-lb" style="flex-direction:column;align-items:flex-start;gap:2px">
 <span>แจ้งเมื่อบอทตั้งชื่อเล่นให้คุณ</span>
 <span style="font-size:11px;color:var(--pp-txt3)">ปิดแล้วบอทยังตั้งได้ แต่คุณจะไม่เห็นแจ้งเตือน — ไปดูเองได้ที่ตั้งค่าแชท</span></span>
 <label class="pp-switch"><input type="checkbox" id="pp-set-nicknotify"${cfg.nicknameNotify !== false ? ' checked' : ''}><span></span></label></div>
 <div class="pp-cell"><span class="pp-cell-lb" style="flex-direction:column;align-items:flex-start;gap:2px">
 <span>ส่องข้อความที่บอทยกเลิกได้</span>
 <span style="font-size:11px;color:var(--pp-txt3)">แตะแถบเทาเพื่อดูว่าเขาเกือบพูดอะไร · ปิดแล้วจะเห็นแค่ว่ามีข้อความถูกยกเลิก</span></span>
 <label class="pp-switch"><input type="checkbox" id="pp-set-peek"${cfg.unsendPeekEnabled !== false ? ' checked' : ''}><span></span></label></div>
 </div>

 <div class="pp-sec-label">${ICON.fire} ระบบดราม่า / ชื่อเสียง</div>
 <div class="pp-card">
 <div class="pp-cell">
 <span class="pp-cell-lb" style="flex-direction:column;align-items:flex-start;gap:2px">
 <span>เปิดระบบดราม่าสังคมไทย</span>
 <span style="font-size:11px;color:var(--pp-txt3);line-height:1.4">คนแปลกหน้า ยอดฟอลขึ้นลง คอมเมนต์แซะ · ยิงเฉพาะตอนคุณกดให้บอทคอมเมนต์ ไม่ใช่ทุกเทิร์น</span>
 </span>
 <span style="display:flex;align-items:center;gap:9px;flex-shrink:0">
 <span class="pp-tokchip${cfg.dramaEnabled ? ' on' : ''}">${tk('drama')}</span>
 <label class="pp-switch"><input type="checkbox" id="pp-set-dramaon"${cfg.dramaEnabled ? ' checked' : ''}><span></span></label>
 </span>
 </div>
 ${cfg.dramaEnabled ? `
 <div class="pp-cell"><span class="pp-cell-lb">${ICON.person} ผู้ติดตามผี</span>
 <label class="pp-switch"><input type="checkbox" id="pp-set-ghost"${cfg.ghostEnabled !== false ? ' checked' : ''}><span></span></label></div>
 <div class="pp-cell"><span class="pp-cell-lb">ระดับความเดือด</span>
 <select class="pp-sel" id="pp-set-drama">
 <option value="calm"${cfg.dramaLevel === 'calm' ? ' selected' : ''}>ใจเย็น</option>
 <option value="normal"${cfg.dramaLevel === 'normal' ? ' selected' : ''}>ปกติ</option>
 <option value="spicy"${cfg.dramaLevel === 'spicy' ? ' selected' : ''}>เดือดง่าย</option>
 </select></div>
 <div class="pp-cell"><span class="pp-cell-lb">โอกาสคนแปลกหน้าทักแชท (%)</span>
 <input class="pp-num" type="number" id="pp-set-ghostdm" min="0" max="5" value="${cfg.ghostDmChance == null ? 2 : cfg.ghostDmChance}"></div>
 <div class="pp-cell tap" id="pp-set-cloutseed"><span class="pp-cell-lb">${ICON.chart} ยอดผู้ติดตามตอนนี้</span>
 <span class="pp-cell-val">${totalFollowerCount().toLocaleString('en-US')}${ICON.chevron}</span></div>
 <div class="pp-cell tap" id="pp-set-cloutreset"><span class="pp-cell-lb">${ICON.trash} ล้างชื่อเสียงทั้งหมด</span>
 <span class="pp-cell-val">${ICON.chevron}</span></div>` : ''}
 </div>

 <div class="pp-sec-label">${ICON.eye} การเชื่อมกับบทหลัก</div>
 <div class="pp-card">
 <div class="pp-cell"><span class="pp-cell-lb">เปิดสะพานเชื่อม (จำเป็นสำหรับทุกอย่างข้างบน)</span>
 <label class="pp-switch"><input type="checkbox" id="pp-set-autosync"${cfg.autoSyncEnabled !== false ? ' checked' : ''}><span></span></label></div>
 <div class="pp-cell"><span class="pp-cell-lb">โหมดหนึ่งคำขอเท่านั้น (ไม่ยิง API ซ้ำ)</span>
 <label class="pp-switch"><input type="checkbox" id="pp-set-singlecall"${cfg.singleRequestMode !== false ? ' checked' : ''}><span></span></label></div>
 <div class="pp-cell"><span class="pp-cell-lb">แจ้งผลซิงค์เป็น toast ทุกเทิร์น</span>
 <label class="pp-switch"><input type="checkbox" id="pp-set-syncreceipt"${cfg.syncReceipts !== false ? ' checked' : ''}><span></span></label></div>
 <div class="pp-cell"><span class="pp-cell-lb">เหตุการณ์สูงสุดต่อคำตอบ</span>
 <input class="pp-num" type="number" id="pp-set-syncmax" min="1" max="20" value="${cfg.syncMaxEvents || 8}"></div>
 <div class="pp-cell tap" data-nav="syncview"><span class="pp-cell-lb">${ICON.chart} ผลซิงค์ล่าสุด</span>
 <span class="pp-cell-val">${esc(ppSyncReceiptLabel(cfg.lastSyncReceipt))}${ICON.chevron}</span></div>
 <div class="pp-cell tap" data-nav="logview"><span class="pp-cell-lb">${ICON.compose} บันทึกกิจกรรมที่ค้างคิว</span>
 <span class="pp-cell-val">${ppLogCount()} รายการ${ICON.chevron}</span></div>
 </div>

 <div class="pp-sec-label">บันทึกกิจกรรมของคุณ</div>
 <div class="pp-card">
 <div class="pp-cell"><span class="pp-cell-lb">เก็บสิ่งที่คุณทำในมือถือ</span>
 <label class="pp-switch"><input type="checkbox" id="pp-set-logstory"${cfg.logToStory ? ' checked' : ''}><span></span></label></div>
 <div class="pp-cell"><span class="pp-cell-lb">แทรกบรรทัด "ไม่ได้แตะมือถือ" เมื่อว่าง</span>
 <label class="pp-switch"><input type="checkbox" id="pp-set-logidle"${cfg.logIdleNote ? ' checked' : ''}><span></span></label></div>
 <div class="pp-cell"><span class="pp-cell-lb">เก็บเรื่องส่วนตัวด้วย (ติดดาว/ปิดเสียง)</span>
 <label class="pp-switch"><input type="checkbox" id="pp-set-logminor"${cfg.logMinorActions ? ' checked' : ''}><span></span></label></div>
 <div class="pp-cell"><span class="pp-cell-lb">เหตุการณ์สูงสุดต่อการส่ง</span>
 <input class="pp-num" type="number" id="pp-set-logmax" min="5" max="200" value="${cfg.logMaxEvents || 60}"></div>
 </div>
 <div class="pp-btn-row"><button class="pp-btn" id="pp-set-logpreview">ดูตัวอย่างที่จะส่ง</button></div>

 <div class="pp-sec-label">ขอบเขตคอนแทกต์</div>
 <div class="pp-card">
 <div class="pp-cell tap" id="pp-set-fixnpc"><span class="pp-cell-lb" style="flex-direction:column;align-items:flex-start;gap:2px">
 <span>${ICON.regen} รวมตัวละครหลักที่ถูกสร้างซ้ำ</span>
 <span style="font-size:11px;color:var(--pp-txt3);line-height:1.4">ถ้าตัวละครหลักโผล่ในหมวด NPC เพราะบอทสะกดชื่อเพี้ยน กดนี่เพื่อยุบรวมกลับ</span></span>
 <span class="pp-cell-val">${ICON.chevron}</span></div>
 <div class="pp-cell"><span class="pp-cell-lb">บอท/NPC ทักข้ามแชท</span>
 <label class="pp-switch"><input type="checkbox" id="pp-set-universe"${cfg.sharedUniverse ? ' checked' : ''}><span></span></label></div>
 <div class="pp-cell"><span class="pp-cell-lb">ให้ตัวละครหลักหยิบมือถือตอบแทนได้</span>
 <label class="pp-switch"><input type="checkbox" id="pp-set-botreply"${cfg.allowBotReplyOnPhone ? ' checked' : ''}><span></span></label></div>
 <div class="pp-cell"><span class="pp-cell-lb">โฟกัสเข้ม: ซ่อน NPC ที่ไม่ผูกตัวละคร</span>
 <label class="pp-switch"><input type="checkbox" id="pp-set-strictnpc"${cfg.strictNpcScope ? ' checked' : ''}><span></span></label></div>
 </div>

 <div class="pp-sec-label">หน้าตา</div>
 <div class="pp-card">
 <div class="pp-cell"><span class="pp-cell-lb">โหมดมืด</span>
 <label class="pp-switch"><input type="checkbox" id="pp-set-dark"${cfg.theme === 'dark' ? ' checked' : ''}><span></span></label></div>
 <div class="pp-cell"><span class="pp-cell-lb">ปุ่มลอยบนหน้าจอ</span>
 <label class="pp-switch"><input type="checkbox" id="pp-set-fab"${cfg.showFab !== false ? ' checked' : ''}><span></span></label></div>
 <div class="pp-cell"><span class="pp-cell-lb">แสดงเลขแจ้งเตือนบนปุ่มลอย</span>
 <label class="pp-switch"><input type="checkbox" id="pp-set-fabbadge"${cfg.showFabBadge !== false ? ' checked' : ''}><span></span></label></div>
 <div class="pp-cell"><span class="pp-cell-lb">Dynamic Island</span>
 <label class="pp-switch"><input type="checkbox" id="pp-set-island"${cfg.dynamicIsland ? ' checked' : ''}><span></span></label></div>
 <div class="pp-cell"><span class="pp-cell-lb">แจ้งเตือนนอกมือถือ</span>
 <label class="pp-switch"><input type="checkbox" id="pp-set-scope2"${cfg.islandScope === 'always' ? ' checked' : ''}><span></span></label></div>
 <div class="pp-cell"><span class="pp-cell-lb">สีหลัก</span>
 <label class="pp-color-wrap"><input type="color" id="pp-set-accent" value="${esc(cfg.accent || '#0a84ff')}"><span></span></label></div>
 </div>
 <div class="pp-sec-label">พื้นหลังหน้าจอ</div>
 <div class="pp-swatches">
 ${Object.keys(WALLPAPERS).map(k => `<button class="pp-swatch${cfg.wallpaper === k ? ' on' : ''}" data-wp="${k}" style="background:${WALLPAPERS[k]};background-size:cover"></button>`).join('')}
 <button class="pp-swatch${cfg.wallpaper === 'custom' ? ' on' : ''}" data-wp="custom" style="background:var(--pp-fill2)">รูป</button>
 </div>
 <div class="pp-card"><div class="pp-cell"><span class="pp-cell-lb">ความเบลอพื้นหลัง</span>
 <input type="range" id="pp-set-blur" min="0" max="30" step="1" value="${cfg.homeBlur ?? 6}" style="flex:1;max-width:52%"></div></div>

 <div class="pp-sec-label">โปรไฟล์และรูป</div>
 <div class="pp-card">
 <div class="pp-cell"><span class="pp-cell-lb">ใช้รูปจาก SillyTavern อัตโนมัติ</span>
 <label class="pp-switch"><input type="checkbox" id="pp-set-avauto"${cfg.userAvatarMode === 'auto' ? ' checked' : ''}><span></span></label></div>
 <div class="pp-cell"><span class="pp-cell-lb">คำบรรยายรูป</span>
 <select class="pp-sel" id="pp-set-caption">
 <option value="ask"${cfg.imageCaptionMode === 'ask' ? ' selected' : ''}>ถามทุกครั้ง</option>
 <option value="self"${cfg.imageCaptionMode === 'self' ? ' selected' : ''}>พิมพ์เอง</option>
 <option value="ai"${cfg.imageCaptionMode === 'ai' ? ' selected' : ''}>ให้ AI อ่านภาพ</option>
 </select></div>
 </div>
 ${cfg.userAvatarMode === 'custom' ? `<label class="pp-upload" id="pp-user-av-wrap" style="margin:8px 0">${ICON.upload} อัปโหลดรูปโปรไฟล์เอง<input type="file" id="pp-user-av-pick" accept="image/*" hidden></label>` : ''}

 <div class="pp-sec-label">Persona ของฉัน</div>
 <div class="pp-card">
 <div class="pp-cell"><span class="pp-cell-lb">โหมด</span>
 <select class="pp-sel" id="pp-set-personamode">
 <option value="perchat"${cfg.userPersonaMode === 'perchat' ? ' selected' : ''}>แยกแต่ละแชท</option>
 <option value="shared"${cfg.userPersonaMode === 'shared' ? ' selected' : ''}>เหมือนกันทุกแชท</option>
 </select></div>
 ${cfg.userPersonaMode === 'shared' ? `<div class="pp-cell"><span class="pp-cell-lb">เลือก persona</span>
 <select class="pp-sel" id="pp-set-sharedpersona">
 <option value="">ค่าเริ่มต้น (ST ปัจจุบัน)</option>
 ${personas.map(p => `<option value="${esc(p.id)}"${cfg.sharedUserPersonaId === p.id ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}
 </select></div>` : ''}
 </div>

 <div class="pp-sec-label">โทรศัพท์</div>
 <div class="pp-card">
 <div class="pp-cell"><span class="pp-cell-lb">บอทโทรหาได้เอง</span>
 <label class="pp-switch"><input type="checkbox" id="pp-set-botcall"${cfg.botCallKeyword ? ' checked' : ''}><span></span></label></div>
 <div class="pp-cell"><span class="pp-cell-lb">เปิดประวัติสายไว้เป็นค่าเริ่มต้น</span>
 <label class="pp-switch"><input type="checkbox" id="pp-set-callhist"${cfg.callHistoryOpen ? ' checked' : ''}><span></span></label></div>
 <div class="pp-cell pp-cell-col">
 <div class="pp-cell-lb" style="margin-bottom:6px">เสียงเรียกเข้า (ลิงก์)</div>
 <input class="pp-input-line" id="pp-set-ringtone" placeholder="วางลิงก์ mp3/ogg (เว้นว่าง = ไม่มีเสียง)" value="${esc(cfg.ringtoneUrl || '')}">
 </div>
 </div>

 <div class="pp-sec-label">อื่น ๆ</div>
 <div class="pp-card">
 <div class="pp-cell tap" data-nav="stickers"><span class="pp-cell-lb">${ICON.sticker} จัดการสติกเกอร์</span>
 <span class="pp-cell-val">${allStickers().length}${ICON.chevron}</span></div>
 <div class="pp-cell"><span class="pp-cell-lb">${ICON.money} แยกกระเป๋าเงินตามแชท</span>
 <label class="pp-switch"><input type="checkbox" id="pp-w-perchat"${cfg.walletPerChat ? ' checked' : ''}><span></span></label></div>
 <div class="pp-cell tap" id="pp-set-diag"><span class="pp-cell-lb">${ICON.chart} ตรวจระบบ (Diagnostics)</span>
 <span class="pp-cell-val">${ICON.chevron}</span></div>
 </div>
 <div class="pp-hint" style="text-align:center;padding:14px 0">Pocket Phone ${PP_VERSION}</div>`;

 // วัดโทเคนครั้งแรกแล้วแคช — ไม่ยิง API ใด ๆ ใช้ tokenizer ในเครื่อง
 if (!cfg.bridgeTokenCache) {
  ppMeasureBridgeTokens(false).then(() => { if (ppCurrentScreen === 'settings') renderPhoneSettings(); });
 }
}
function renderSyncView() {
 const cfg = getCfg();
 const body = document.getElementById('pp-syncview-body');
 if (!body) return;
 const r = cfg.lastSyncReceipt;
 const s = cfg.syncStats || {};
 const rows = (cfg.syncEventLog || []).slice().reverse();
 const statusColor = st => st === 'applied' ? '#30d158' : st === 'noop' ? 'var(--pp-txt3)' : '#ff453a';
 body.innerHTML = `
 <div class="pp-tokcard" style="background:linear-gradient(150deg,rgba(10,132,255,.85),rgba(94,92,230,.7))">
 <div class="pp-tokcard-top">
 <span class="pp-tokcard-lb">ผลซิงค์เทิร์นล่าสุด</span>
 <span class="pp-tokcard-num" style="font-size:22px">${esc(ppSyncReceiptLabel(r))}</span>
 </div>
 <div class="pp-tokcard-sub">${r ? esc(fmtNoteAge(r.ts)) : 'ยังไม่มีข้อมูล'}${r && r.detail ? ' · ' + esc(r.detail) : ''}</div>
 </div>
 <div class="pp-pstats">
 <div class="pp-pstat"><b>${s.turns || 0}</b><span>เทิร์นที่ผ่านมา</span></div>
 <div class="pp-pstat"><b style="color:#30d158">${s.applied || 0}</b><span>เข้าสำเร็จ</span></div>
 <div class="pp-pstat"><b style="color:#ff453a">${(s.missing || 0) + (s.invalid || 0)}</b><span>พลาด</span></div>
 </div>
 <div class="pp-hint">"ไม่พบชุดข้อมูล" = บอทลืมแนบ frame มา ลองกดรีเจนคำตอบนั้นใหม่ · "ผิดรูป" = บอทเขียน JSON เพี้ยน ระบบพยายามกู้ซากให้แล้ว · "โมดูลปิดอยู่" = คุณปิดโมดูลนั้นในตั้งค่า ไม่ใช่บั๊ก</div>
 <div class="pp-sec-label">รายการทีละอัน (ล่าสุดอยู่บน)</div>
 ${rows.length ? `<div class="pp-card">${rows.map(x => `<div class="pp-cell pp-cell-col">
 <div style="display:flex;align-items:center;gap:8px;width:100%">
 <span style="width:8px;height:8px;border-radius:50%;flex-shrink:0;background:${x.ok ? '#30d158' : '#ff453a'}"></span>
 <span style="flex:1;min-width:0;font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
 ${esc(x.type)}${x.label ? ' · ' + esc(x.label) : ''}</span>
 <span style="font-size:11px;color:var(--pp-txt3);flex-shrink:0">${esc(fmtNoteAge(x.ts))}</span>
 </div>
 ${!x.ok && x.reason ? `<div class="pp-hint" style="margin:4px 0 0 16px">${esc(x.reason)}</div>` : ''}
 </div>`).join('')}</div>` : `<div class="pp-empty">${ICON.chart}<br>ยังไม่มีรายการ<span>เล่นโรลไปหนึ่งเทิร์นแล้วกลับมาดู</span></div>`}
 <div class="pp-btn-row"><button class="pp-btn danger" id="pp-sync-clear">${ICON.trash} ล้างรายการ</button></div>`;
}
function ppExportStickers() {
 const packs = getStickerPacks();
 if (!packs.length) { ppToast('ยังไม่มีชุดให้ export'); return; }
 const data = packs.map(p => ({ name: p.name, items: (p.items || []).map(it => ({ label: it.label || '', url: it.url })) }));
 try {
 const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
 const url = URL.createObjectURL(blob);
 const a = document.createElement('a');
 a.href = url; a.download = 'pocket-phone-stickers.json';
 document.body.appendChild(a); a.click(); a.remove();
 setTimeout(() => URL.revokeObjectURL(url), 1000);
 ppToast('ส่งออกไฟล์ JSON แล้ว');
 } catch (e) { console.error(e); ppToast('ส่งออกไม่ได้'); }
}
function ppImportStickersFromText(text) {
 let data;
 try { data = JSON.parse(text); } catch {
  ppAlert('ไฟล์นี้ไม่ใช่ไฟล์รายการสติกเกอร์',
   `ปุ่มนี้รับได้แค่ไฟล์รายการ (.json) ที่ส่งออกมาจากแอปนี้เท่านั้น<br><br>
    ถ้าคุณต้องการ<b>เพิ่มรูปสติกเกอร์จากเครื่อง</b> ให้ใช้ปุ่ม
    "เพิ่มสติกเกอร์จากรูปในเครื่อง" แทน — อยู่ในเมนูเดียวกัน อันบนสุด`);
  return;
 }
 const packsIn = Array.isArray(data) ? data : (data && data.items ? [data] : null);
 if (!packsIn) { ppToast('รูปแบบไฟล์ไม่รองรับ'); return; }
 const cfg = getCfg();
 let added = 0, skipped = 0;
 packsIn.forEach(pk => {
 if (!pk || !pk.name || !Array.isArray(pk.items)) { skipped++; return; }
 const items = pk.items.filter(it => it && it.url).map(it => ({ url: String(it.url), label: String(it.label || '') }));
 if (!items.length) { skipped++; return; }
 let name = String(pk.name).slice(0, 24);
 const dup = cfg.stickerPacks.find(x => x.name === name);
 if (dup) {
 // ไม่เขียนทับเงียบ — ต่อท้ายเลข
 let n = 2, base = name;
 while (cfg.stickerPacks.find(x => x.name === `${base} (${n})`)) n++;
 name = `${base} (${n})`;
 }
 cfg.stickerPacks.push({ id: newId(), name, items });
 added++;
 });
 saveCfg();
 renderStickerManager();
 ppToast(`นําเข้า ${added} ชุด${skipped ? ` · ข้าม ${skipped}` : ''}`);
}
function ppStickerImportMenu() {
 ppSheet('สติกเกอร์', [
  { label: 'เพิ่มสติกเกอร์จากรูปในเครื่อง', icon: ICON.image, onClick: ppPickStickerImages },
  { label: 'นำเข้าจากไฟล์รายการ (.json)', icon: ICON.upload, onClick: () => document.getElementById('pp-sticker-import-file')?.click() },
  { label: 'ส่งออกทุกชุดเป็นไฟล์รายการ', icon: ICON.share, onClick: ppExportStickers },
 ]);
}
/** ★ 1.4.0 เลือกรูปหลายรูปจากเครื่อง → ย่อ → ตั้งชื่อป้ายทีละรูป */
/** ★ 1.4.1 หา input ให้ได้แน่ ถ้าไม่มีก็สร้างสด ๆ แล้วผูก listener ทันที */
function ppStickerFileInput() {
 let inp = document.getElementById('pp-sticker-img-file');
 if (!inp) {
  inp = document.createElement('input');
  inp.type = 'file';
  inp.id = 'pp-sticker-img-file';
  inp.accept = 'image/*';
  inp.multiple = true;
  inp.hidden = true;
  (document.getElementById('pp-frame') || document.body).appendChild(inp);
 }
 if (!inp._ppBound) {
  inp._ppBound = true;
  inp.addEventListener('change', e => {
   const pid = inp.dataset.pack;
   const files = e.target.files;
   inp.value = '';
   if (!pid) { ppToast('ไม่รู้ว่าจะเพิ่มเข้าชุดไหน ลองกดใหม่'); return; }
   if (!files || !files.length) return;
   ppHandleStickerImages(pid, files);
  });
 }
 return inp;
}
function ppPickStickerImages(packId) {
 const packs = getStickerPacks();
 const go = pid => {
  const inp = ppStickerFileInput();
  inp.dataset.pack = pid;
  setTimeout(() => inp.click(), 30);
 };
 const makeNew = () => ppPrompt('ตั้งชื่อชุดสติกเกอร์ใหม่', '', name => {
  name = (name || '').trim();
  if (!name) return;
  const p = { id: newId(), name: name.slice(0, 24), items: [] };
  getCfg().stickerPacks.push(p);
  saveCfg();
  go(p.id);
 }, { rows: 1, hint: 'เช่น แมวขาว หรือ ชุดกวน ๆ' });

 if (packId) return go(packId);
 if (!packs.length) return makeNew();
 ppSheet('เพิ่มรูปเข้าชุดไหน', packs.map(p => ({
  label: `${p.name} (${(p.items || []).length} รูป)`, icon: ICON.sticker, onClick: () => go(p.id),
 })).concat([{ label: 'สร้างชุดใหม่', icon: ICON.plus, onClick: makeNew }]));
}
async function ppHandleStickerImages(packId, files) {
 const pack = findStickerPack(packId);
 if (!pack) { ppToast('ไม่พบชุดสติกเกอร์ ลองกดใหม่'); return; }
 if (!pack.items) pack.items = [];
 const list = Array.from(files).slice(0, 24);
 if (!list.length) { ppToast('ไม่ได้เลือกไฟล์'); return; }
 let added = 0, failed = 0;
 const startIdx = pack.items.length;
 islandStatus(`กำลังย่อรูป ${list.length} รูป…`);
 for (const f of list) {
  const looksImage = /^image\//i.test(f.type || '') || /\.(png|jpe?g|gif|webp|bmp|avif)$/i.test(f.name || '');
  if (!looksImage) { failed++; continue; }
  let dataUrl = null;
  try { dataUrl = await ppReadImageFile(f, 512); } catch (e) { console.warn('[pocket-phone] sticker read', e); }
  if (!dataUrl) { failed++; continue; }
  const key = 'stk-' + newId();
  let ok = false;
  try { ok = await saveMedia(key, dataUrl); } catch (e) { console.warn('[pocket-phone] sticker save', e); }
  if (!ok) { failed++; continue; }
  pack.items.push({ url: dataUrl, mediaKey: key, label: '' });
  added++;
 }
 saveCfg();
 islandCollapse();
 renderStickerManager();
 if (!added) {
  ppAlert('เพิ่มรูปไม่สำเร็จ',
   `ลองไม่ผ่านทั้ง ${list.length} ไฟล์<br><br>
    สาเหตุที่เจอบ่อย: ไฟล์ไม่ใช่รูปภาพ · รูปใหญ่มากจนย่อไม่ผ่าน · พื้นที่เก็บข้อมูลของเบราว์เซอร์เต็ม<br><br>
    ลองรูปที่เล็กลง หรือเลือกทีละสองสามรูป`);
  return;
 }
 ppToast(`เพิ่ม ${added} รูป${failed ? ` · ข้าม ${failed}` : ''} — ต่อไปตั้งชื่อป้าย`);
 // ★ 1.4.1 ถามชื่อป้ายทีละรูปเฉพาะรูปที่เพิ่งเพิ่ม พร้อมโชว์รูปให้ดูว่ากำลังตั้งชื่ออันไหน
 const fresh = [];
 for (let i = startIdx; i < pack.items.length; i++) fresh.push(i);
 const askNext = k => {
  if (k >= fresh.length) { renderStickerManager(); ppToast('ตั้งชื่อป้ายครบแล้ว'); return; }
  const i = fresh[k];
  const it = pack.items[i];
  if (!it) return askNext(k + 1);
  const ov = ppOverlay('center', `<div class="pp-dlg">
   <div class="pp-dlg-title">ตั้งชื่อป้าย (${k + 1} จาก ${fresh.length})</div>
   <div style="display:flex;justify-content:center;margin-bottom:12px">
    <img src="${esc(it.url)}" style="width:96px;height:96px;object-fit:contain;border-radius:14px;background:var(--pp-fill3)">
   </div>
   <input class="pp-input-line pp-stk-lb" placeholder="เช่น ยิ้มเขิน, งอน, หัวเราะ" value="${esc(it.label || '')}">
   <div class="pp-hint" style="margin:8px 0 0">บอทเรียกสติกเกอร์จากชื่อนี้ · เว้นว่างได้ แต่บอทจะส่งรูปนี้ไม่ได้</div>
   <div class="pp-dlg-row">
    <button class="pp-btn pp-stk-skip">ข้าม</button>
    <button class="pp-btn primary pp-stk-ok">ถัดไป</button>
   </div>
  </div>`);
  const inEl = ov.querySelector('.pp-stk-lb');
  setTimeout(() => inEl?.focus(), 80);
  const done = save => {
   if (save) { it.label = (inEl.value || '').trim().slice(0, 40); saveCfg(); }
   ov.remove();
   setTimeout(() => askNext(k + 1), 120);
  };
  inEl.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); done(true); } });
  ov.querySelector('.pp-stk-ok')?.addEventListener('click', () => done(true));
  ov.querySelector('.pp-stk-skip')?.addEventListener('click', () => done(false));
 };
 setTimeout(() => askNext(0), 500);
}
function renderStickerManager() {
 const body = document.getElementById('pp-stickers-body');
 if (!body) return;
 const packs = getStickerPacks();
 if (!packs.length) {
 body.innerHTML = `<div class="pp-empty">${ICON.sticker}<br>ยังไม่มีชุดสติกเกอร์<span>เริ่มจากปุ่มด้านล่าง</span></div>
 <button class="pp-btn primary wide" id="pp-stk-quickimg" style="margin-bottom:8px">${ICON.image} เพิ่มรูปจากเครื่อง</button>
 <button class="pp-btn wide" id="pp-sticker-add-pack2">${ICON.plus} สร้างชุดเปล่า</button>
 <div class="pp-hint">รูปจากเครื่องจะถูกย่อให้เล็กอัตโนมัติ · ตั้งชื่อป้ายทุกรูปด้วย เพราะบอทเรียกสติกเกอร์จากชื่อป้าย ไม่ใช่จากรูป</div>`;
 return;
 }
 body.innerHTML = `<button class="pp-btn primary wide" id="pp-stk-quickimg" style="margin-bottom:10px">${ICON.image} เพิ่มรูปสติกเกอร์จากเครื่อง</button>`
 + packs.map(p => `
 <div class="pp-sec-label">${esc(p.name)} (${(p.items || []).length})
 <button class="pp-btn" data-spimg="${esc(p.id)}" style="margin-left:auto;padding:5px 11px">${ICON.image}รูป</button>
 <button class="pp-btn" data-spadd="${esc(p.id)}" style="padding:5px 11px">${ICON.link}ลิงก์</button>
 <button class="pp-btn" data-sprename="${esc(p.id)}" style="padding:5px 11px">แก้ชื่อ</button>
 <button class="pp-btn danger" data-spdel="${esc(p.id)}" style="padding:5px 11px">${ICON.trash}</button>
 </div>
 <div class="pp-card">${(p.items || []).length
 ? (p.items || []).map((it, i) => `<div class="pp-cell">
 <span class="pp-cell-lb"><img src="${esc(it.url)}" style="width:34px;height:34px;object-fit:contain;border-radius:9px;background:var(--pp-fill3)" onerror="this.style.opacity='.2'">
 <span style="min-width:0;overflow:hidden;text-overflow:ellipsis;${it.label ? '' : 'color:#ff9f0a'}">${esc(it.label || 'ยังไม่มีชื่อป้าย — บอทส่งไม่ได้')}</span></span>
 <span style="display:flex;gap:5px;flex-shrink:0">
 <button class="pp-btn" data-silabel="${esc(p.id)}:${i}" style="padding:5px 10px">${ICON.compose}</button>
 <button class="pp-btn danger" data-sidel="${esc(p.id)}:${i}" style="padding:5px 10px">${ICON.trash}</button>
 </span>
 </div>`).join('')
 : `<div class="pp-cell"><span class="pp-cell-lb" style="color:var(--pp-txt3)">ชุดนี้ยังว่าง</span></div>`}
 </div>`).join('')
 + `<div class="pp-hint">บอทเรียกสติกเกอร์จาก<b>ชื่อป้าย</b> ไม่ใช่จากรูป — รูปที่ไม่มีป้าย บอทส่งไม่ได้<br>
 ชื่อป้ายที่ใช้ได้ตอนนี้: ${esc(stickerPromptList() || 'ยังไม่มีเลย')}<br><br>
 อยากให้บอทเห็นรายชื่อป้ายพวกนี้ ต้องเปิดสวิตช์ "รายชื่อป้ายสติกเกอร์" ในตั้งค่า</div>`;
}
function renderLogView() {
 const body = document.getElementById('pp-logview-body');
 if (!body) return;
 const cfg = getCfg();
 const events = (cfg.actionLog || []).slice().reverse();
 const selCount = events.filter(e => ppLogSelected.has(e.id)).length;
 body.innerHTML = `
 <div class="pp-card"><div class="pp-cell">
 <span class="pp-cell-lb">${ICON.compose} เหตุการณ์ค้างคิว</span>
 <span class="pp-cell-val">${events.length} รายการ</span></div></div>
 <div class="pp-hint">รายการเหล่านี้จะเข้า system prompt ชั่วคราวในการเจนโรลเพลย์ครั้งถัดไป แล้วล้างเฉพาะเมื่อคำตอบมาถึง · ข้อความที่คุณพิมพ์จะไม่ถูกแก้ไข · แตะวงกลมเพื่อเลือกแล้วลบ</div>
 ${selCount ? `<div class="pp-btn-row" style="margin:0 0 8px">
 <button class="pp-btn danger" id="pp-log-delsel">${ICON.trash} ลบที่เลือก (${selCount})</button>
 <button class="pp-btn" id="pp-log-clearsel">ยกเลิกเลือก</button>
 </div>` : ''}
 ${events.length ? `<div class="pp-card">${events.map(e => `<div class="pp-cell pp-cell-col">
 <div style="display:flex;align-items:flex-start;gap:8px;width:100%">
 <span class="pp-ms-check${ppLogSelected.has(e.id) ? ' on' : ''}" data-logsel="${esc(e.id)}" style="flex-shrink:0;margin-top:2px">${ppLogSelected.has(e.id) ? ICON.check : ''}</span>
 <div style="flex:1;min-width:0">
 <div class="pp-cell-lb" style="font-size:14px">${esc(e.text)}</div>
 ${e.sub && e.sub.length ? `<div class="pp-hint" style="margin:4px 0 0">${e.sub.map(s => esc(s)).join('<br>')}</div>` : ''}
 <div class="pp-hint" style="margin:4px 0 0;opacity:.6">${esc(fmtNoteAge(e.ts))}</div>
 </div>
 </div>
 </div>`).join('')}</div>` : `<div class="pp-empty">${ICON.check}<br>ไม่มีอะไรค้างคิว</div>`}
 <div class="pp-sec-label">${ICON.eye} ข้อมูลที่จะส่งชั่วคราว</div>
 <div class="pp-promptbox">${esc(ppPreviewLog())}</div>`;
}

// ══════════════════════════════════════════════════════════
// GENERATION CORE
// ══════════════════════════════════════════════════════════
function showGenControls(active) {
 const gen = document.getElementById('pp-gen');
 const stop = document.getElementById('pp-stop');
 if (gen) gen.style.display = active ? 'none' : 'flex';
 if (stop) stop.style.display = active ? 'flex' : 'none';
 const input = document.getElementById('pp-input');
 if (input) input.disabled = !!active;
}
function ppStopGen() {
 if (!ppGeneratingId) return;
 ppGenAbort = true;
 try { const c = ctx(); if (c && typeof c.stopGeneration === 'function') c.stopGeneration(); } catch {}
 hideTyping(); islandCollapse(); showGenControls(false);
}
function ppGenerationError(e) {
 const raw = String((e && (e.message || e.error || e.statusText)) || e || '').trim();
 if (!raw) return 'ไม่ทราบสาเหตุ';
 if (/no.?connection|not connected|offline|failed to fetch|network/i.test(raw)) return 'SillyTavern ยังไม่ได้เชื่อมต่อ API';
 if (/quota|credit|insufficient|billing/i.test(raw)) return 'โควตาหรือเครดิต API ไม่เพียงพอ';
 if (/rate.?limit|\b429\b/i.test(raw)) return 'API จำกัดความถี่ กรุณารอสักครู่';
 return raw.slice(0, 160);
}
async function ppCallGenerator(fn, owner, prompt, kind) {
 if (typeof fn !== 'function') throw new Error('ไม่พบฟังก์ชันสร้างข้อความ');
 // ST 1.13.2+ uses one object argument. Old builds expose several arguments.
 // Detect before calling, so compatibility never costs an extra API request.
 if (fn.length <= 1) {
  if (kind === 'quiet') return await fn.call(owner, { quietPrompt: prompt });
  return await fn.call(owner, { prompt });
 }
 if (kind === 'quiet') return await fn.call(owner, prompt, false, false);
 return await fn.call(owner, prompt, '', false, false);
}
async function genOnce(prompt) {
 return ppGenEnqueue(async () => {
  const c = ctx();
  const cap = ppDetect(true);
  if (cap.genQuiet) return await ppCallGenerator(c.generateQuietPrompt, c, prompt, 'quiet');
  if (typeof window.generateQuietPrompt === 'function') return await ppCallGenerator(window.generateQuietPrompt, window, prompt, 'quiet');
  if (cap.genRaw) return await ppCallGenerator(c.generateRaw, c, prompt, 'raw');
  if (typeof window.generateRaw === 'function') return await ppCallGenerator(window.generateRaw, window, prompt, 'raw');
  throw new Error('SillyTavern เวอร์ชันนี้ไม่มีช่องทางสร้างข้อความ');
 });
}
async function genWithRetry(prompt, tries) {
 let lastErr = null;
 // Strict mode means exactly one provider request. A retry is another quota unit,
 // so failures are surfaced to the user instead of being spent silently.
 const n = getCfg().singleRequestMode !== false ? 1 : (tries || 3);
 for (let t = 0; t < n; t++) {
 if (ppGenAbort || ppFeedGenAbort) return '';
 try { const raw = await genOnce(prompt); if (cleanReply(raw)) { ppTrackTokens(prompt, raw); return raw; } }
 catch (e) { lastErr = e; console.warn('[pocket-phone] gen retry', t + 1, e); }
 await new Promise(r => setTimeout(r, 400 * (t + 1)));
 }
 if (lastErr) throw lastErr;
 return '';
}
/** บริบทมือถือที่ป้อนให้บอทในแอป (แยกจาก Action Log ที่ส่งเข้าบทหลัก) */
function phoneContextFor(cid) {
 const cfg = getCfg();
 const bits = [];
 const un = getUserDisplayName();
 if (cfg.accountLocked) bits.push(`${un}'s feed account is private.`);
 if (isCloseFriend(cid)) bits.push(`You are on ${un}'s close friends list.`);
 if (isRestricted(cid)) bits.push(`${un} has restricted you — you can see less of their activity.`);
 const myPosts = getFeedPosts().filter(p => p.author === 'user').slice(-2);
 const visible = myPosts.filter(p => postAudience(p).some(x => x.id === cid));
 if (visible.length) {
 bits.push('Recent posts by ' + un + ' that you can see:');
 visible.forEach(p => {
 const caps = (p.captions || []).filter(Boolean);
 bits.push(`- "${(p.text || '').slice(0, 90)}"${caps.length ? ` [images: ${caps.join(' / ')}]` : (postMediaKeys(p).length ? ' [image, no caption given]' : '')}`);
 });
 }
 const st = liveStories().filter(s => s.author === 'user' && (!s.closeOnly || isCloseFriend(cid))).slice(-1)[0];
 if (st) bits.push(`${un} posted a story: "${(st.text || '[image]').slice(0, 80)}"`);
 const bal = getBotWallet(cid);
 bits.push(`Your own wallet balance is about ${fmtMoney(bal)}.`);
 const req = (cfg.walletRequests || []).find(r => r.cid === cid && r.status === 'pending');
 if (req) bits.push(`${un} asked you for ${fmtMoney(req.amount)}${req.note ? ` (${req.note})` : ''} — you may agree or refuse in character.`);
 return bits.join('\n');
}
function botCapabilityLines(cid) {
 const cfg = getCfg();
 const un = getUserDisplayName();
 const lines = [];
 if (cfg.botCallKeyword) lines.push(`CALLING (important): if your character truly wants to hear ${un}'s voice, ACTUALLY call now — put a clear phrase like "โทรหา" / "เดี๋ยวโทร" / "รับสายด้วย" inside a quoted line and the app starts the call at once. Never keep promising to call across many replies without doing it.`);
 const stickers = stickerPromptList();
 if (stickers) lines.push(`Sticker: [STICKER] label — labels: ${stickers}`);
 lines.push(`Voice (rare): [VOICE] the words`);
 lines.push(`Status: [NOTE] short status`);
 lines.push(`Location: [LOCATION] place | note`);
 lines.push(`Recall your own last message (${un} will only see "ยกเลิกข้อความแล้ว"): [UNSEND]`);
 if (cid && !isGroupId(cid)) lines.push(`Send money only if it fits (wallet ~${fmtMoney(getBotWallet(cid))}): [PP_PAY:amount|reason]`);
 if (cfg.accountLocked && cid && !isFollower(cid)) lines.push(`Request to follow: [PP_FOLLOW]`);
 return lines;
}
/** parse คำสั่งพิเศษจากคำตอบบอท */
function parseBotCommands(raw, cid) {
 const out = { note: null, voice: null, sticker: null, location: null, pay: null, follow: false, unsend: false };
 const noteM = raw.match(/\[NOTE\]\s*(.+)$/im);
 if (noteM) out.note = stripEmoji(noteM[1].trim().replace(/["“”„«»「」『』]/g, ''));
 const vM = raw.match(/\[VOICE\]\s*(.+)$/im);
 if (vM) { const t = stripEmoji(vM[1].trim().replace(/["“”„«»「」『']/g, '')); if (t) out.voice = t; }
 const sM = raw.match(/\[STICKER\]\s*(.+)$/im);
 if (sM) { const st = findStickerByLabel(sM[1].trim().replace(/["“”„«»「」『']/g, '')); if (st) out.sticker = st; }
 const lM = raw.match(/\[LOCATION\]\s*([^|\]\n]+)(?:\|\s*([^\n\]]*))?/i);
 if (lM) out.location = { place: stripEmoji(lM[1].trim()), note: stripEmoji((lM[2] || '').trim()) };
 const pM = raw.match(/\[PP_PAY:\s*(\d+)\s*(?:\|\s*([^\]]*))?\]/i);
 if (pM) out.pay = { amount: Math.abs(parseInt(pM[1], 10) || 0), note: (pM[2] || '').trim() };
 if (/\[PP_FOLLOW\]/i.test(raw)) out.follow = true;
 if (/\[UNSEND\]/i.test(raw)) out.unsend = true;
 return out;
}
async function ppRegenerate() {
 const c = ppActiveContact;
 if (!c || ppGeneratingId || ppActiveGroup) return;
 const th = getThread(c.id);
 while (th.length && th[th.length - 1].from === 'them' && th[th.length - 1].type !== 'call' && th[th.length - 1].type !== 'transfer') th.pop();
 saveCfg();
 renderThread();
 ppGenerateReply();
}
function findMentionedContact(text, excludeId) {
 const s = String(text || '');
 const cands = getContacts().filter(c => c.id !== excludeId && !isBlocked(c.id))
 .map(c => ({ c, names: [c.name, c.customName].filter(Boolean) }))
 .sort((a, b) => Math.max(...b.names.map(n => n.length)) - Math.max(...a.names.map(n => n.length)));
 for (const { c, names } of cands) for (const nm of names) if (nm && nm.length >= 2 && s.includes(nm)) return c;
 return null;
}
async function universeInterject(interloper) {
 try {
 const un = getUserDisplayName();
 const persona = getEffectivePersona(interloper.id);
 const th = getThread(interloper.id).slice(-6);
 const hist = th.map(m => `${m.from === 'me' ? un : dname(interloper)}: ${m.text || msgPreview(m)}`).join('\n');
 const prompt = [
 `[Text messaging app — you are strictly ${dname(interloper)}, messaging ${un} right now.]`,
 persona ? `You are this character. Stay in persona: ${persona}` : null,
 hist ? `\nEarlier messages with ${un}:\n${hist}` : `\nYou haven't talked with ${un} in a while.`,
 `\nSend a short spontaneous message (1-2 lines). Put EVERY line inside quotes " ".`,
 `Same language as ${un} (Thai). No emoji. No planning. No narration. Only quoted chat text.`,
 ].filter(Boolean).join('\n');
 const raw = await genWithRetry(prompt, 2);
 const lines = spokenOrFallback(raw, 2);
 if (!lines.length) return;
 lines.forEach(t => pushThreadMsg(interloper.id, { from: 'them', text: t }));
 bumpUnread(interloper.id, lines.length);
 pushNotif(interloper.id, 'msg', lines[0]);
 renderContactList(); updateHomeWidgets();
 if (ppViewing(interloper.id)) islandShowReplies(interloper, [lines[0]]);
 else islandNotify(interloper, lines[0]);
 } catch (e) { console.warn('[pocket-phone] universe interject failed', e); }
}
async function ppGenerateReply() {
 if (ppActiveGroup) return ppGroupGenerate();
 const c = ppActiveContact;
 if (!c || ppGeneratingId || ppCall) return;
 if (isBlocked(c.id)) { ppToast('คุณบล็อกคนนี้อยู่'); return; }
 const input = document.getElementById('pp-input');
 if (input && input.value.trim()) ppSendUserMessage();
 // ส่งข้อความตั้งเวลาก่อน
 const cfgSched = getCfg().scheduled || {};
 if (cfgSched[c.id]) {
 const t = cfgSched[c.id];
 pushThreadMsg(c.id, { from: 'me', text: t });
 ppLog('chat', `ส่งข้อความที่ตั้งเวลาไว้ให้ ${dname(c)}: "${t}"`);
 delete getCfg().scheduled[c.id];
 saveCfg();
 renderThread();
 }
 if (!getThread(c.id).some(m => m.from === 'me')) { ppToast('พิมพ์ข้อความก่อน แล้วค่อยกดให้บอทตอบ'); return; }

 ppGeneratingId = c.id;
 ppGenAbort = false;
 showGenControls(true);
 if (ppViewing(c.id)) { document.querySelector('#pp-msgs .pp-regen-row')?.remove(); showTyping(); }
 islandTyping(c);
 renderContactList();

 let produced = [], failed = false, botCalls = false, mentioned = null, aborted = false;
 try {
 const un = getUserDisplayName();
 // ตัวละครหลัก: การ์ด+persona ถูกโหลดโดย generateQuietPrompt แล้ว ไม่ฉีดซ้ำ (ประหยัดหลักหมื่นโทเคน)
 if (c.loreBook) { try { await ppFetchLoreForContact(c.id); } catch {} }
 const persona = (c.id === currentCharacterId()) ? '' : getEffectivePersona(c.id);
 const up = getEffectiveUserPersona(c.id);
 const note = getUserNote();
 const isMainChar = c.id === currentCharacterId();
 // ไม่ดึง recap โรลหลักเข้า prompt แชทแล้ว — บอทหลักแชร์ประวัติผ่านตัว SillyTavern เองอยู่แล้ว (ประหยัดโทเคน)
 const rp = '';
 const period = periodPromptNote(c.id);
 const phone = '';
 const th = getThread(c.id).slice(-HIST_LIMIT);
 const hist = th.map(m => {
 if (m.type === 'call') return `[${m.dir === 'out' ? `${un} called ${dname(c)}` : `${dname(c)} called ${un}`}${m.text ? ': ' + m.text : ''}]`;
 if (m.type === 'transfer') return `[${m.from === 'me' ? `${un} transferred ${fmtMoney(m.amount)} to ${dname(c)}` : `${dname(c)} sent ${fmtMoney(m.amount)} to ${un}`}${m.note ? ' — ' + m.note : ''}${m.status === 'declined' ? ' (declined)' : ''}]`;
 if (m.type === 'image') return `${m.from === 'me' ? un : dname(c)}: [image${m.caption ? ': ' + m.caption : ', no caption'}]`;
 if (m.type === 'voice') return `${m.from === 'me' ? un : dname(c)}: (voice) ${m.text}`;
 if (m.type === 'sticker') return `${m.from === 'me' ? un : dname(c)}: [sticker${m.label ? ' ' + m.label : ''}]`;
 if (m.type === 'location') return `${m.from === 'me' ? un : dname(c)}: [location: ${m.place}${m.note ? ' — ' + m.note : ''}]`;
 if (m.type === 'contactcard') return `${m.from === 'me' ? un : dname(c)}: [contact card: ${cname(m.cardId)}]`;
 if (m.type === 'gift') return `${m.from === 'me' ? un : dname(c)}: [gift: ${m.giftName}]`;
 if (m.type === 'sharedpost') { const p = findPost(m.postId); return `${m.from === 'me' ? un : dname(c)}: [shared post: ${p ? (p.text || '[image]').slice(0, 80) : 'deleted'}]`; }
 const pre = m.replyTo ? `(replying to ${m.replyTo.kind}: ${m.replyTo.text}) ` : '';
 return `${m.from === 'me' ? un : dname(c)}: ${pre}${m.text}`;
 }).join('\n');

 const prompt = [
 `[Text messaging app — you are strictly ${dname(c)}, chatting with ${un}.]`,
 persona ? `You ARE this character. Stay fully in this persona: ${persona}` : null,
 (up && (up.name || up.desc)) ? `Who you are chatting with (${un}): ${[up.name ? 'Name: ' + up.name : '', up.desc].filter(Boolean).join(' — ')}` : null,
 rp ? `IMPORTANT — this phone chat is the SAME continuous relationship as your main story with ${un}. Carry over your exact current feelings, warmth, tension, and how close you are. Do NOT reset to a cold/neutral tone. Recent story between you two:\n${rp}` : null,
 `Stay consistent with your ENTIRE chat history in this thread above — your mood and closeness build on all of it, not just the last message.`,
 period ? `Important — ${period}` : null,
 phone ? `What you can see on your phone:\n${phone}` : null,
 note ? `${un}'s current status note reads: "${note.text}". You may glance at it. Mention it ONLY if your character would naturally care — otherwise ignore it and just answer their latest message. Do NOT force a reaction.` : null,
 hist ? `\n<history>\n${hist}\n</history>` : null,
 `\nReply to ${un}'s LAST message, in character as ${dname(c)}, with 1-3 short chat lines.`,
 `Reply in the SAME language the conversation uses (Thai if Thai).`,
 `OUTPUT FORMAT (strict): put EVERY chat line inside double quotes " ".`,
 `Output ONLY quoted chat lines. No planning, no thoughts, no narration, no actions, no asterisks. Anything outside " " will be discarded.`,
 ...botCapabilityLines(c.id),
 ].filter(Boolean).join('\n');

 const raw = await genWithRetry(prompt, 3);
 if (ppGenAbort) aborted = true;
 else {
 const cmd = parseBotCommands(raw, c.id);
 if (cmd.note) setBotNote(c.id, cmd.note);
 if (cmd.follow) {
 const cfg = getCfg();
 if (!cfg.followRequests.includes(c.id) && !isFollower(c.id)) {
 cfg.followRequests.push(c.id);
 saveCfg();
 pushNotif(c.id, 'follow', `${dname(c)} ขอติดตามคุณ`);
 }
 }
 if (cmd.unsend) {
 const thNow = getThread(c.id);
 for (let i = thNow.length - 1; i >= 0; i--) {
 const mm = thNow[i];
 if (mm.from === 'them' && !mm.unsent && mm.type !== 'call' && mm.type !== 'transfer' && (mm.text || mm.type === 'voice')) {
 mm.unsent = true; mm.origText = mm.text || ''; saveCfg();
 if (ppViewing(c.id)) renderThread(); else renderContactList();
 break;
 }
 }
 }
 const lines = spokenOrFallback(raw, 3);
 const wantCall = getCfg().botCallKeyword && lines.some(wantsToCall);
 if (!lines.length && !cmd.voice && !cmd.sticker && !cmd.pay && !cmd.location) failed = true;
 else if (wantCall) botCalls = true;
 else {
 for (let i = 0; i < lines.length && !ppGenAbort; i++) {
 await new Promise(r => setTimeout(r, i === 0 ? 300 : 500 + Math.random() * 400));
 if (ppGenAbort) break;
 pushThreadMsg(c.id, { from: 'them', text: lines[i] });
 produced.push(lines[i]);
 if (ppViewing(c.id)) renderThread();
 }
 if (cmd.sticker && !ppGenAbort) {
 await new Promise(r => setTimeout(r, 350));
 pushThreadMsg(c.id, { from: 'them', type: 'sticker', url: cmd.sticker.url, label: cmd.sticker.label });
 if (ppViewing(c.id)) renderThread();
 }
 if (cmd.voice && !ppGenAbort) {
 await new Promise(r => setTimeout(r, 350));
 pushThreadMsg(c.id, { from: 'them', type: 'voice', text: cmd.voice, dur: Math.min(40, Math.max(2, Math.round(cmd.voice.length / 8))) });
 if (ppViewing(c.id)) renderThread();
 }
 if (cmd.location && cmd.location.place && !ppGenAbort) {
 pushThreadMsg(c.id, { from: 'them', type: 'location', place: cmd.location.place, note: cmd.location.note });
 if (ppViewing(c.id)) renderThread();
 }
 if (cmd.pay && cmd.pay.amount > 0 && cmd.pay.amount <= getBotWallet(c.id) && !ppGenAbort) {
 pushThreadMsg(c.id, { from: 'them', type: 'transfer', amount: cmd.pay.amount, note: cmd.pay.note, status: 'pending' });
 const req = (getCfg().walletRequests || []).find(r => r.cid === c.id && r.status === 'pending');
 if (req) { req.status = 'sent'; saveCfg(); }
 if (ppViewing(c.id)) renderThread();
 }
 if (ppGenAbort) aborted = true;
 if (getCfg().sharedUniverse && !aborted) mentioned = findMentionedContact(produced.join(' '), c.id);
 }
 }
 } catch (e) { failed = true; console.error('[pocket-phone] generate', e); }
 finally {
 ppGeneratingId = null;
 showGenControls(false);
 hideTyping();
 renderNotesRow();
 if (aborted) { islandCollapse(); if (ppViewing(c.id)) renderThread(); else renderContactList(); ppToast('หยุดแล้ว'); }
 else if (botCalls) { islandCollapse(); ppIncomingCall(c); }
 else if (failed) { islandCollapse(); ppToast('เชื่อมต่อไม่ได้ ลองกดอีกครั้ง'); if (ppViewing(c.id)) renderThread(); else renderContactList(); }
 else {
 if (ppViewing(c.id)) { renderThread(); islandCollapse(); }
 else {
 bumpUnread(c.id, produced.length || 1);
 renderContactList(); updateHomeWidgets();
 if (produced.length) { pushNotif(c.id, 'msg', produced[0]); islandNotify(c, produced[0]); } else islandCollapse();
 }
 // universeInterject performs another provider call. Strict mode relies on the
 // main-response sync batch instead so one user action cannot spend twice.
 if (mentioned && getCfg().singleRequestMode === false) setTimeout(() => universeInterject(mentioned), 1600);
 }
 }
}
async function ppGroupGenerate() {
 const g = ppActiveGroup;
 if (!g || ppGeneratingId || ppCall) return;
 const input = document.getElementById('pp-input');
 if (input && input.value.trim()) ppSendUserMessage();
 const now = Date.now();
 if (now < ppGroupCooldownUntil) { ppToast(`รออีก ${Math.ceil((ppGroupCooldownUntil - now) / 1000)} วิ`); return; }
 const members = groupMemberContacts(g).filter(c => !isBlocked(c.id));
 if (!members.length) { ppToast('กลุ่มนี้ไม่มีสมาชิก'); return; }

 ppGeneratingId = g.id;
 ppGenAbort = false;
 showGenControls(true);
 let any = false, failed = false;
 try {
 const un = getUserDisplayName();
 const rp = getCfg().universeAffectsRP ? mainChatRecap(10) : '';
 const order = g.replyMode === 'one' ? [members[Math.floor(Math.random() * members.length)]] : members.slice();
 if (ppViewing(g.id)) { document.querySelector('#pp-msgs .pp-regen-row')?.remove(); showTyping('สมาชิกกลุ่ม'); }
 islandStatus('สมาชิกกลุ่มกำลังตอบ…');
 const th = getThread(g.id).slice(-HIST_LIMIT);
 const hist = th.map(m => {
 const who = m.from === 'me' ? un : (m.senderName || '?');
 if (m.type === 'poll') return `${who}: [poll: ${m.question} — ${(m.options || []).map(o => `${o.text}(${(o.votes || []).length})`).join(', ')}]`;
 if (m.type === 'image') return `${who}: [image${m.caption ? ': ' + m.caption : ', no caption'}]`;
 if (m.type === 'sticker') return `${who}: [sticker${m.label ? ' ' + m.label : ''}]`;
 if (m.type === 'voice') return `${who}: (voice) ${m.text}`;
 return `${who}: ${m.text || msgPreview(m)}`;
 }).join('\n');
 const profiles = order.map(c => {
 const persona = getEffectivePersona(c.id);
 const period = periodPromptNote(c.id);
 return `- ${dname(c)}: ${persona ? persona.replace(/\s+/g, ' ').slice(0, 420) : '(use the character card already in context)'}${period ? `; private context: ${period}` : ''}`;
 }).join('\n');
 const prompt = [
 `[Group chat "${g.name}". Generate the selected members together in ONE response. Members: ${members.map(dname).join(', ')} and ${un}.]`,
 `Selected responders and personas:\n${profiles}`,
 g.warnNote ? `Group rules/notes: ${g.warnNote}` : null,
 g.knowEachOther ? `They know each other and may naturally respond to one another.` : `They do not know one another; each responds mainly to ${un}.`,
 rp ? `Ongoing story context:\n${rp}` : null,
 hist ? `\n<history>\n${hist}\n</history>` : null,
 `Each selected responder may send 0-2 short lines. Format every message EXACTLY: [CharacterName] "message"`,
 `A member may vote with: [POLL CharacterName] option text`,
 `Use only these responder names: ${order.map(dname).join(', ')}. Same language as the chat (Thai when Thai).`,
 `No planning, narration, actions, emoji, or asterisks. Output only formatted message/vote lines.`,
 ].filter(Boolean).join('\n');
 const raw = await genWithRetry(prompt, 1);
 hideTyping();
 if (ppGenAbort) return;
 const counts = {};
 for (const row of String(raw || '').split(/\n+/).map(x => x.trim()).filter(Boolean)) {
 const poll = row.match(/^\[POLL\s+([^\]]+)\]\s*(.+)$/i);
 if (poll) {
 const voter = order.find(x => dname(x) === poll[1].trim()) || order.find(x => poll[1].includes(dname(x)) || dname(x).includes(poll[1]));
 if (!voter) continue;
 const want = stripEmoji(poll[2].trim().replace(/["“”„«»「」『']/g, '')).toLowerCase();
 const th2 = getThread(g.id);
 for (let i = th2.length - 1; i >= 0; i--) {
 const pmsg = th2[i];
 if (pmsg.type !== 'poll') continue;
 const opt = (pmsg.options || []).find(o => String(o.text).toLowerCase().includes(want) || want.includes(String(o.text).toLowerCase()));
 if (opt) { opt.votes = (opt.votes || []).filter(v => v !== voter.id); opt.votes.push(voter.id); saveCfg(); }
 break;
 }
 continue;
 }
 const mm = row.match(/^\[([^\]]+)\]\s*(.+)$/);
 if (!mm) continue;
 const c = order.find(x => dname(x) === mm[1].trim()) || order.find(x => mm[1].includes(dname(x)) || dname(x).includes(mm[1]));
 if (!c || (counts[c.id] || 0) >= 2) continue;
 const spoken = extractSpoken(mm[2]);
 const ln = spoken.length ? spoken[0] : stripEmoji(cleanReply(mm[2]).replace(/^["'“”‘’„«»「」『』]+|["'“”‘’„«»「」『』]+$/g, '')).trim();
 if (!ln || looksLikeThought(ln)) continue;
 counts[c.id] = (counts[c.id] || 0) + 1;
 await new Promise(r => setTimeout(r, 220 + Math.random() * 220));
 pushThreadMsg(g.id, { from: 'them', sender: c.id, senderName: dname(c), text: ln });
 any = true;
 if (ppViewing(g.id)) renderThread();
 }
 } catch (e) { failed = true; console.error('[pocket-phone] group gen', e); }
 finally {
 ppGeneratingId = null;
 showGenControls(false);
 hideTyping();
 if (g.cooldownSec) ppGroupCooldownUntil = Date.now() + g.cooldownSec * 1000;
 if (ppGenAbort) ppToast('หยุดแล้ว');
 else if (!any) ppToast(failed ? 'เชื่อมต่อไม่ได้ — ไม่ยิงซ้ำเพื่อประหยัดโควตา' : 'สมาชิกยังไม่ตอบ');
 if (ppViewing(g.id)) { renderThread(); islandCollapse(); }
 else {
 if (any) {
 bumpUnread(g.id, 1);
 const last = getThread(g.id).slice().reverse().find(m => m.from === 'them');
 if (last) { pushNotif(g.id, 'group', `${last.senderName}: ${last.text}`); islandNotify({ id: g.id, name: g.name, avatar: '' }, `${last.senderName}: ${last.text}`); }
 }
 renderContactList(); updateHomeWidgets(); islandCollapse();
 }
 }
}
function showFeedGenControls(active) {
 const g = document.getElementById('pp-feed-gen-btn'); if (g) g.style.display = active ? 'none' : 'flex';
 const s = document.getElementById('pp-feed-stop-btn'); if (s) s.style.display = active ? 'flex' : 'none';
}
function showPostGenControls(active) {
 const g = document.getElementById('pp-post-gen-btn'); if (g) g.style.display = active ? 'none' : 'flex';
 const s = document.getElementById('pp-post-stop-btn'); if (s) s.style.display = active ? 'flex' : 'none';
}
function ppStopFeedGen() {
 ppFeedGenAbort = true; ppGenAbort = true;
 try { const c = ctx(); if (c && typeof c.stopGeneration === 'function') c.stopGeneration(); } catch {}
 islandCollapse();
 showFeedGenControls(false); showPostGenControls(false);
 ppToast('หยุดแล้ว');
}
function ppPickFeedAuthor() {
 const cfg = getCfg();
 let pool = getContacts().filter(c => !isBlocked(c.id));
 if (!pool.length) { ppToast('ยังไม่มีคอนแทกต์ให้โพสต์'); return; }
 ppSheet('ให้ใครโพสต์', [
 { label: 'สุ่มบอท', icon: ICON.generate, onClick: () => ppFeedGenerate(null) },
 ...pool.map(c => ({ label: dname(c), icon: ICON.person, onClick: () => ppFeedGenerate(c.id) })),
 ]);
}
async function ppFeedGenerate(forcedAuthorId) {
 if (ppFeedGenBusy || ppGeneratingId) return;
 const cfg = getCfg();
 let pool = getContacts().filter(c => !isBlocked(c.id));
 if (cfg.universeAffectsRP) pool = pool.filter(c => c.id !== currentCharacterId());
 if (!pool.length) { ppToast('ยังไม่มีคอนแทกต์ให้โพสต์'); return; }
 ppFeedGenBusy = true; ppFeedGenAbort = false; ppGenAbort = false;
 showFeedGenControls(true);
 islandStatus('กําลังให้บอทเคลื่อนไหว...');
 try {
 const isNews = !forcedAuthorId && Math.random() < 0.18;
 const author = forcedAuthorId ? findContact(forcedAuthorId) : pool[Math.floor(Math.random() * pool.length)];
 if (!author && !isNews) { ppToast('ไม่พบบอท'); return; }
 const persona = author ? getEffectivePersona(author.id) : '';
 const rp = cfg.universeAffectsRP && author ? mainChatRecap(12) : '';
 const period = author ? periodPromptNote(author.id) : '';
 const phone = author ? phoneContextFor(author.id) : '';
 const prompt = [
 isNews ? `[In-world news feed. Write a short news item from a local news source in this world.]`
 : `[Social media app — you ARE strictly ${dname(author)}. Post only in this character's own voice.]`,
 !isNews && persona ? `You are this character. Stay fully in persona: ${persona}` : null,
 rp ? `Ongoing story context (keep your personality and relationship consistent):\n${rp}` : null,
 period ? `Context about ${getUserDisplayName()}: ${period}` : null,
 (!isNews && phone) ? `What you saw on your phone:\n${phone}` : null,
 isNews ? `Write one short headline + 1-2 line body, each line inside quotes " ". Then a new line: [LIKES] N. Then optionally: [SOURCE] news outlet name.`
 : `Write a short spontaneous post (1-3 short lines) as ${dname(author)}. Put EVERY line inside quotes " ". Then a new line: [LIKES] N (realistic like count).`,
 `Reply in Thai. No emoji. No planning. No narration. Only the quoted post text + the [LIKES] line.`,
 ].filter(Boolean).join('\n');
 const raw = await genWithRetry(prompt, 3);
 if (ppFeedGenAbort) { ppToast('หยุดแล้ว'); return; }
 const likesM = raw.match(/\[LIKES\]\s*(\d+)/i);
 const extraLikes = likesM ? parseInt(likesM[1], 10) : (Math.floor(Math.random() * 40) + 5);
 const text = spokenOrFallback(raw, 4).join('\n');
 const srcM = String(raw || '').match(/\[SOURCE\]\s*([^\n\]]{1,40})/i);
 const newsSrc = srcM ? stripEmoji(srcM[1].trim()) : 'ข่าวด่วน';
 if (text) {
 cfg.feedPosts.push({
 id: newId(), author: isNews ? 'news' : author.id, kind: isNews ? 'news' : 'post',
 newsSource: isNews ? newsSrc : undefined,
 authorName: isNews ? newsSrc : dname(author), handle: isNews ? newsSrc : undefined,
 text: text.slice(0, 1000), mediaKeys: [], captions: [],
 responders: null, knowEachOther: true, visibility: 'all',
 ts: Date.now(), likes: [], extraLikes, comments: [], views: {}, saves: 0,
 });
 // ★ 1.0.0 : บอทแท็กผู้ใช้ในโพสต์
 const justAdded = cfg.feedPosts[cfg.feedPosts.length - 1];
 if (justAdded) {
  extractMentions(justAdded.text).forEach(h => {
   const r = resolveMention(h);
   if (r && r.user) {
    pushMention(justAdded.id, justAdded.author, justAdded.text);
    pushNotif(justAdded.author, 'comment', `${postAuthorLabel(justAdded)} แท็กคุณในโพสต์`);
   }
  });
 }
 saveCfg(); if (ppCurrentScreen === 'newsapp') renderNewsApp(); else renderFeed();
 ppToast('มีโพสต์ใหม่');
 if (!isNews) { pushNotif(author.id, 'feed', `${dname(author)} โพสต์ใหม่`); if (!document.getElementById('pp-dialog')?.open) islandNotify(author, `${dname(author)} โพสต์ใหม่`); }
 } else ppToast('บอทยังไม่โพสต์ ลองอีกครั้ง');
 } catch (e) { console.error('[pocket-phone] feed gen', e); ppToast('สร้างโพสต์ไม่สำเร็จ: ' + ppGenerationError(e)); }
 finally { ppFeedGenBusy = false; ppFeedGenAbort = false; ppGenAbort = false; islandCollapse(); showFeedGenControls(false); }
}
function ppPickCommenters() {
 const p = findPost(ppActivePost);
 if (!p) return;
 const pool = postAudience(p);
 if (!pool.length) { ppToast('ไม่มีใครที่เห็นโพสต์นี้และตอบได้'); return; }
 ppSheet('ให้ใครคอมเมนต์', [
 { label: 'สุ่มบอท (เลือกจํานวน)', icon: ICON.generate, onClick: () => {
 ppPrompt('สุ่มกี่คน', '3', v => {
 const n = Math.max(1, Math.min(pool.length, parseInt(v, 10) || 3));
 const shuffled = pool.slice().sort(() => Math.random() - 0.5).slice(0, n);
 ppPostGenerate(shuffled.map(c => c.id));
 }, { rows: 1 });
 } },
 { label: 'เลือกรายคน', icon: ICON.person, onClick: () => {
 ppMultiSelect({ title: 'เลือกบอทที่จะคอมเมนต์', selected: [],
 items: pool.map(c => ({ id: c.id, label: dname(c), avatar: c.avatar })),
 onDone: arr => { if (arr.length) ppPostGenerate(arr); else ppToast('ยังไม่ได้เลือก'); } });
 } },
 { label: 'ทุกคนที่เห็นโพสต์', icon: ICON.users, onClick: () => ppPostGenerate(null) },
 ]);
}
async function ppPostGenerate(onlyIds) {
 const p = findPost(ppActivePost);
 if (!p || ppFeedGenBusy) return;
 let pool = postAudience(p);
 if (Array.isArray(onlyIds) && onlyIds.length) pool = pool.filter(c => onlyIds.includes(c.id));
 if (!pool.length) { ppToast('ไม่มีใครที่เห็นโพสต์นี้และตอบได้'); return; }
 ppFeedGenBusy = true; ppFeedGenAbort = false; ppGenAbort = false;
 showPostGenControls(true);
 islandStatus('กำลังให้บอทคอมเมนต์…');
 try {
 const names = pool.map(dname);
 const profiles = pool.map(c => {
 const pr = getEffectivePersona(c.id);
 return `- ${dname(c)}: ${pr ? pr.replace(/\n+/g, ' ').slice(0, 160) : '(ไม่มีข้อมูล)'}`;
 }).join('\n');
 const existing = (p.comments || []).map(cm => `${commentAuthorLabel(cm)}: ${cm.text}`).join('\n');
 const caps = (p.captions || []).filter(Boolean);
 const know = p.knowEachOther !== false;
 const prompt = [
 `[Social media comment section. Each character comments strictly IN THEIR OWN persona and voice.]`,
 `Post by ${postAuthorLabel(p)}: "${String(p.text || '[image]').slice(0, 400)}"`,
 caps.length ? `Images in post: ${caps.join(' / ')}` : (postMediaKeys(p).length ? 'Post has an image but the poster gave no caption.' : null),
 p.poll ? `Poll in post: "${p.poll.question}" options: ${p.poll.options.map(o => o.text).join(' / ')}` : null,
 p.question ? `Question box in post: "${p.question}"` : null,
 `Character profiles (obey each voice exactly):\n${profiles}`,
 getCfg().universeAffectsRP ? `Story context:\n${mainChatRecap(10)}` : null,
 periodPromptNote() ? `Note about ${getUserDisplayName()}: ${periodPromptNote()}` : null,
 existing ? `Existing comments:\n${existing}` : null,
 know ? `These characters KNOW each other and can reply to one another and to ${getUserDisplayName()}.`
 : `These characters do NOT know each other — each only reacts to the post itself.`,
 (getCfg().dramaEnabled && ghostOn()) ? `ALSO: this account has ${totalFollowerCount()} followers, so random strangers see this post too. Add 1-3 stranger comments — invent short Thai internet nicknames yourself. Format each on its own line EXACTLY: [GHOST]nickname|N "comment text". Strangers can be nosy, supportive, or start petty drama. Keep them SHORT.` : null,
 (getCfg().dramaEnabled && p.author === 'user') ? `FINALLY, on the very last line, judge how Thai social media receives this post, format EXACTLY: [CLOUT] good|0-3|short reason  (use good / mid / bad ; second number = drama heat 0=none 3=full flame war). Thai netizens are quick to find something to argue about, so do not default to "good".` : null,
 `Generate several NEW comments. Each on ITS OWN line, format EXACTLY: [CharacterName|N] "comment text"`,
 know ? `To reply to an earlier commenter: [CharacterName|N > TargetName] "comment text"` : '',
 `Put comment text inside quotes " ". N = small realistic like count. Use ONLY these names: ${names.join(', ')}. Thai.`,
 `STRICT: quoted text = only what that character would type. No planning, no narration, no asterisks.`,
 ].filter(Boolean).join('\n');
 const raw = await genWithRetry(prompt, 3);
 if (ppFeedGenAbort) { ppToast('หยุดแล้ว'); return; }
 const lines = String(raw || '').split(/\n+/).map(l => l.trim()).filter(Boolean);
 let added = 0;
 if (!p.comments) p.comments = [];
 for (const line of lines) {
 const mm = line.match(/^\[([^|\]>]+?)\s*\|?\s*(\d*)\s*(?:>\s*([^\]]+))?\]\s*(.+)$/);
 if (!mm) continue;
 const authorName = mm[1].trim();
 const likes = parseInt(mm[2] || '0', 10) || 0;
 const targetName = (mm[3] || '').trim();
 const q = extractSpoken(mm[4]);
 const text = q.length ? q[0] : stripEmoji(cleanReply(mm[4]).replace(/^["'“”‘’„«»「」『』]+|["'“”‘’„«»「」『』]+$/g, '')).trim();
 if (!text || looksLikeThought(text)) continue;
 // เฉพาะตัวละครใน pool เท่านั้น กันชื่อ/แอคหลุดคาร์
 const c = pool.find(x => dname(x) === authorName)
 || pool.find(x => authorName && (authorName.includes(dname(x)) || dname(x).includes(authorName)));
 if (!c) continue;
 let parentId = null;
 if (know && targetName) {
 const par = (p.comments || []).slice().reverse().find(cm => commentAuthorLabel(cm) === targetName || targetName.includes(commentAuthorLabel(cm)));
 if (par) parentId = par.id;
 }
 p.comments.push({ id: newId(), author: c.id, text, ts: Date.now(), likes: [], extraLikes: likes, parentId });
 p.views = p.views || {}; p.views[c.id] = Date.now();
 pushNotif(c.id, 'comment', `${dname(c)} คอมเมนต์: ${text.slice(0, 40)}`);
 added++;
 }
 // ★ 1.0.0 คอมเมนต์ผี (1.3.0: ปิดได้จากสวิตช์ดราม่า)
 if (getCfg().dramaEnabled && ghostOn()) {
  const ghosts = parseGhostComments(raw);
  ghosts.slice(0, 3).forEach(g => {
   ghostRememberName(g.name);
   const reg = Math.random() < 0.22;
   if (reg) ghostPromoteRegular(g.name, g.name);
   p.comments.push({
    id: newId(), author: 'ghost:' + g.name, authorName: g.name, handle: g.name,
    ghost: true, text: g.text, ts: Date.now(), likes: [],
    extraLikes: g.likes || Math.floor(Math.random() * 6), parentId: null,
   });
   added++;
  });
  // ผีทักแชท — โอกาสน้อยมาก
  if (ghosts.length) {
   const dm = ghostMaybeDm(ghosts[0].name);
   if (dm) {
    pushThreadMsg(dm.id, { from: 'them', text: `เห็นโพสต์แล้วอยากทักมาคุยหน่อย` });
    bumpUnread(dm.id, 1);
    pushNotif(dm.id, 'msg', `${dname(dm)} ทักมาจากโพสต์`);
    ppLog('feed', `มีคนแปลกหน้าชื่อ ${dname(dm)} ทักแชทมาหลังเห็นโพสต์`);
    islandNotify(dm, 'ทักมาจากโพสต์');
   }
  }
 }
 // ★ 1.0.0 ตัดสินกระแส (1.3.0: ปิดได้)
 let cloutMsg = '';
 if (getCfg().dramaEnabled && p.author === 'user') {
  const verdict = parseCloutBlock(raw);
  if (verdict) {
   const res = cloutJudgePost(p, verdict);
   if (res) {
    cloutMsg = res.summary;
    ppLog('feed', res.summary, verdict.note ? [`เหตุผล: ${verdict.note}`] : null);
   }
  }
 }
 // ★ 1.0.0 บอทแท็กผู้ใช้ในคอมเมนต์
 (p.comments || []).forEach(cm => {
  if (cm.author === 'user' || cm._mchecked) return;
  cm._mchecked = true;
  extractMentions(cm.text).forEach(h => {
   const r = resolveMention(h);
   if (r && r.user) {
    pushMention(p.id, cm.author, cm.text);
    pushNotif(cm.author, 'comment', `${commentAuthorLabel(cm)} แท็กคุณ: ${cm.text.slice(0, 40)}`);
   }
  });
 });
 saveCfg();
 renderPost();
 ppToast(cloutMsg || (added ? `+${added} คอมเมนต์` : 'บอทยังไม่คอมเมนต์ ลองอีกครั้ง'));
 } catch (e) { console.error('[pocket-phone] post gen', e); ppToast('สร้างคอมเมนต์ไม่สำเร็จ: ' + ppGenerationError(e)); }
 finally { ppFeedGenBusy = false; ppFeedGenAbort = false; ppGenAbort = false; islandCollapse(); showPostGenControls(false); }
}

// ══════════════════════════════════════════════════════════
// ★ 1.2.0 ONE-REQUEST PHONE SYNC
// The normal SillyTavern reply carries one plain delimited JSON frame. The
// extension consumes and removes it; no HTML comments/divs and no extra API call.
// ══════════════════════════════════════════════════════════
const PP_SYNC_FRAME_START = '[[POCKET_PHONE_SYNC_V2]]';
const PP_SYNC_FRAME_END = '[[/POCKET_PHONE_SYNC_V2]]';
const PP_LEGACY_SYNC_START_RX = /<!--\s*PP_SYNC\b|\[PP_SYNC\]/i;
const PP_LEGACY_SYNC_DONE_G = /<!--\s*PP_SYNC_DONE(?:\s+invalid)?\s*-->/gi;
let ppPendingActionIds = null;
let ppBridgeExpected = false;

function ppSyncReceiptLabel(r) {
 if (!r) return 'ยังไม่มีข้อมูล';
 if (r.status === 'applied') return `สำเร็จ ${r.applied || 0} รายการ`;
 if (r.status === 'noop') return 'สำเร็จ · ไม่มีการเปลี่ยนแปลง';
 if (r.status === 'missing') return 'ไม่พบชุดซิงค์';
 if (r.status === 'invalid') return 'ชุดซิงค์ไม่ถูกต้อง';
 return String(r.status || 'ไม่ทราบผล');
}
function ppRecordSyncReceipt(status, applied, ignored, detail) {
 const cfg = getCfg();
 const r = { status, applied: applied || 0, ignored: ignored || 0, detail: String(detail || '').slice(0, 220), ts: Date.now() };
 cfg.lastSyncReceipt = r;
 if (!cfg.syncStats || typeof cfg.syncStats !== 'object') cfg.syncStats = {};
 const s = cfg.syncStats;
 s.turns = (s.turns || 0) + 1;
 s[status] = (s[status] || 0) + 1;
 saveCfg();
 if (cfg.syncReceipts !== false) {
  if (status === 'applied') ppToast(`มือถือรับแล้ว ${r.applied} รายการ${r.ignored ? ` · ตก ${r.ignored}` : ''}`);
  else if (status === 'noop') ppToast('มือถือ: เทิร์นนี้ไม่มีอะไรเข้า');
  else if (status === 'missing') ppToast('มือถือ: บอทไม่ได้ส่งชุดข้อมูลมา');
  else ppToast('มือถือ: ชุดข้อมูลผิดรูป · ดูหน้าผลซิงค์');
 }
 console.info('[pocket-phone] sync receipt', r);
 return r;
}
function ppExtractJsonObject(src, searchFrom) {
 const brace = src.indexOf('{', searchFrom);
 if (brace < 0) return { error: 'missing JSON object', jsonEnd: searchFrom };
 let depth = 0, quoted = false, escaped = false;
 for (let i = brace; i < src.length; i++) {
  const ch = src[i];
  if (quoted) {
   if (escaped) escaped = false;
   else if (ch === '\\') escaped = true;
   else if (ch === '"') quoted = false;
   continue;
  }
  if (ch === '"') { quoted = true; continue; }
  if (ch === '{') depth++;
  else if (ch === '}' && --depth === 0) {
   try { return { payload: JSON.parse(src.slice(brace, i + 1)), jsonEnd: i + 1 }; }
   catch (e) { return { error: e && e.message ? e.message : 'invalid JSON', jsonEnd: i + 1 }; }
  }
 }
 return { error: 'unterminated JSON object', jsonEnd: src.length };
}
/** ★ 1.3.0 salvage: ถ้า JSON ทั้งก้อนพัง ให้ไล่แกะ {...} รายอัน อันดีใช้ อันพังข้าม */
function ppSalvageEvents(body) {
 const src = String(body || '');
 const found = [];
 let depth = 0, quoted = false, escaped = false, start = -1;
 for (let i = 0; i < src.length; i++) {
  const ch = src[i];
  if (quoted) {
   if (escaped) escaped = false;
   else if (ch === '\\') escaped = true;
   else if (ch === '"') quoted = false;
   continue;
  }
  if (ch === '"') { quoted = true; continue; }
  if (ch === '{') { if (depth === 0) start = i; depth++; continue; }
  if (ch === '}') {
   depth--;
   if (depth === 0 && start >= 0) {
    const chunk = src.slice(start, i + 1);
    if (/"type"\s*:/.test(chunk)) {
     try { found.push(JSON.parse(chunk)); }
     catch {
      // ซ่อมยอดนิยม: comma ห้อยท้าย · single quote · newline ในสตริง
      try { found.push(JSON.parse(chunk.replace(/,\s*([}\]])/g, '$1').replace(/'/g, '"').replace(/\r?\n/g, ' '))); } catch {}
     }
    }
    start = -1;
   }
   continue;
  }
 }
 return found;
}
function ppExtractSyncBatch(text) {
 const src = String(text || '');
 const start = src.indexOf(PP_SYNC_FRAME_START);
 if (start >= 0) {
  const bodyStart = start + PP_SYNC_FRAME_START.length;
  const close = src.indexOf(PP_SYNC_FRAME_END, bodyStart);
  if (close < 0) return { found: true, start, end: src.length, error: 'unterminated Pocket Phone frame' };
  const body = src.slice(bodyStart, close).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const end = close + PP_SYNC_FRAME_END.length;
  try { return { found: true, start, end, payload: JSON.parse(body), protocol: 'frame-v2' }; }
  catch (e) {
   // ★ 1.3.0 กู้ซาก: JSON พังหนึ่งอัน ไม่ควรทำให้ event ที่ดีหายทั้งก้อน
   const salvaged = ppSalvageEvents(body);
   if (salvaged.length) return { found: true, start, end, payload: { v: 2, events: salvaged }, protocol: 'frame-v2-salvaged', salvaged: salvaged.length };
   return { found: true, start, end, error: e && e.message ? e.message : 'invalid JSON', protocol: 'frame-v2' };
  }
 }
 // Read old chats once so upgrading cannot strand pending legacy data.
 const mm = PP_LEGACY_SYNC_START_RX.exec(src);
 if (!mm) return { found: false };
 const parsed = ppExtractJsonObject(src, mm.index + mm[0].length);
 let markerEnd = parsed.jsonEnd;
 const tail = src.slice(markerEnd, markerEnd + 8).match(/^\s*-->/);
 if (tail) markerEnd += tail[0].length;
 return { found: true, start: mm.index, end: markerEnd, payload: parsed.payload, error: parsed.error, protocol: 'legacy' };
}
function ppFinalizeSyncMarker(text, info) {
 if (!info || !info.found) return String(text || '').replace(PP_LEGACY_SYNC_DONE_G, '').trim();
 const src = String(text || '');
 const before = src.slice(0, info.start).replace(/[ \t]+$/, '').replace(/\n{3,}$/, '\n\n');
 const after = src.slice(info.end).replace(/^[ \t]*(?:\r?\n)?/, '');
 return (before + (before && after ? '\n' : '') + after).replace(PP_LEGACY_SYNC_DONE_G, '').trim();
}
function ppStableHash(value) {
 const s = String(value || '');
 let h = 2166136261;
 for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
 return (h >>> 0).toString(36);
}
function ppMainSyncKey(message, idx, cleanedText) {
 const route = walletRouteKey();
 const stamp = message && (message.send_date || message.gen_started || message.id || message.extra?.api) || '';
 return `${route}|${idx}|${stamp}|${ppStableHash(cleanedText)}`;
}
function ppWasMainSyncHandled(key) {
 const arr = getCfg().processedMainSync;
 return Array.isArray(arr) && arr.includes(key);
}
function ppRememberMainSync(key) {
 const cfg = getCfg();
 if (!Array.isArray(cfg.processedMainSync)) cfg.processedMainSync = [];
 if (!cfg.processedMainSync.includes(key)) cfg.processedMainSync.push(key);
 if (cfg.processedMainSync.length > 160) cfg.processedMainSync = cfg.processedMainSync.slice(-160);
 saveCfg();
}
function ppPrepareActionBatch() {
 const cfg = getCfg();
 if (!cfg.logToStory) return null;
 const max = Math.max(5, cfg.logMaxEvents || 60);
 const events = (cfg.actionLog || []).slice(-max);
 let body = ppBuildLogBody();
 if (!body && cfg.logIdleNote) body = `[อื่น ๆ]\n- ${getUserDisplayName()} ไม่ได้แตะมือถือช่วงนี้`;
 return body ? { ids: events.map(x => x.id), body } : null;
}
function ppCommitActionBatch() {
 if (!ppPendingActionIds) return;
 const cfg = getCfg();
 const sent = new Set(ppPendingActionIds);
 cfg.actionLog = (cfg.actionLog || []).filter(x => !sent.has(x.id));
 ppPendingActionIds = null;
 saveCfg(); ppUpdateLogBadge();
}
function ppCancelActionBatch() { ppPendingActionIds = null; }
/** ★ 1.3.0 ยกเพดานเป็น 12 บรรทัด + รับ text ที่มาเป็นสตริงหลายบรรทัดด้วย */
function ppSyncTextLines(value, max) {
 let arr = Array.isArray(value) ? value : [value];
 const out = [];
 arr.forEach(x => {
  String(x == null ? '' : x).split(/\s*(?:\|\||\r?\n)\s*/).forEach(line => {
   const t = stripEmoji(line.trim());
   if (t) out.push(t.slice(0, 600));
  });
 });
 return out.slice(0, max || 12);
}
/** ★ 1.3.0 field alias — โมเดลใช้ชื่อฟิลด์เพี้ยนบ่อย รับให้หมดโดยไม่เสียโทเคนเพิ่ม */
const PP_FIELD_ALIAS = {
 text: ['text', 'message', 'messages', 'msg', 'content', 'body', 'lines', 'value', 'note_text', 'caption'],
 from: ['from', 'sender', 'author', 'who', 'contact', 'name', 'by', 'to', 'target', 'character', 'char'],
 amount: ['amount', 'value', 'sum', 'money', 'price', 'total'],
 direction: ['direction', 'dir', 'flow', 'way'],
 reason: ['reason', 'note', 'why', 'memo', 'detail', 'description'],
 group: ['group', 'groupName', 'group_name', 'chat', 'room', 'title'],
 place: ['place', 'location', 'where', 'spot'],
 label: ['label', 'sticker', 'name', 'tag'],
 source: ['source', 'outlet', 'publisher', 'channel', 'agency'],
 minutes: ['minutes', 'mins', 'duration', 'length', 'min'],
 count: ['count', 'times', 'n', 'number', 'qty'],
 storyId: ['storyId', 'story_id', 'story'],
 postId: ['postId', 'post_id', 'post'],
 parentId: ['parentId', 'parent_id', 'replyTo', 'reply_to', 'inReplyTo'],
 option: ['option', 'choice', 'index', 'optionIndex'],
 options: ['options', 'choices', 'answers', 'items'],
 question: ['question', 'q', 'prompt', 'poll_question'],
 members: ['members', 'people', 'participants', 'users'],
 transcript: ['transcript', 'lines', 'conversation', 'dialogue', 'log'],
 visibility: ['visibility', 'privacy', 'audience', 'scope'],
 likes: ['likes', 'like', 'likeCount', 'hearts'],
 url: ['url', 'link', 'src', 'image'],
 live: ['live', 'ringing', 'now', 'incoming'],
 closeOnly: ['closeOnly', 'close_only', 'closeFriends', 'closeFriendsOnly'],
};
const PP_TYPE_ALIAS = {
 dm: ['dm', 'message', 'msg', 'text_message', 'chat', 'sms', 'new_message', 'direct_message'],
 nickname: ['nickname', 'rename_user', 'set_nickname', 'contact_name', 'saved_as', 'rename'],
 group_create: ['group_create', 'create_group', 'new_group', 'make_group', 'add_to_group', 'group_invite'],
 wallet_set: ['wallet_set', 'set_wallet', 'set_balance', 'balance', 'my_balance', 'wallet_balance'],
 group: ['group', 'group_message', 'groupchat', 'group_chat'],
 missed_call: ['missed_call', 'missedcall', 'miss_call', 'unanswered_call'],
 call_log: ['call_log', 'calllog', 'past_call', 'call_history'],
 call: ['call', 'incoming_call', 'ringing'],
 wallet: ['wallet', 'payment', 'money', 'transfer', 'transaction', 'pay'],
 wallet_request: ['wallet_request', 'money_request', 'request_money', 'ask_money', 'borrow'],
 comment: ['comment', 'reply', 'post_comment'],
 comment_reply: ['comment_reply', 'reply_comment', 'nested_comment'],
 like: ['like', 'heart', 'react'],
 note: ['note', 'status', 'status_note', 'bio_note'],
 news: ['news', 'headline', 'news_item', 'article'],
 post: ['post', 'feed_post', 'new_post'],
 story: ['story', 'new_story'],
 story_reply: ['story_reply', 'reply_story', 'story_dm'],
 story_like: ['story_like', 'like_story'],
 poll_vote: ['poll_vote', 'vote', 'poll_answer'],
 repost: ['repost', 'share', 'reshare', 'retweet'],
 follow: ['follow', 'followed', 'new_follower'],
 follow_request: ['follow_request', 'request_follow'],
 unfollow: ['unfollow', 'unfollowed'],
 save_post: ['save_post', 'save', 'bookmark'],
 unlike: ['unlike', 'unheart'],
 contact: ['contact', 'new_contact', 'add_contact'],
 voice: ['voice', 'voice_message', 'audio', 'vn'],
 sticker: ['sticker', 'emote'],
 location: ['location', 'place', 'pin', 'share_location'],
 gift: ['gift', 'present'],
 poll: ['poll', 'survey'],
 unsend: ['unsend', 'recall', 'delete_message', 'retract'],
};
/** ทำให้ event มีฟิลด์มาตรฐาน โดยไม่ทิ้งของเดิม */
function ppNormalizeSyncEvent(raw) {
 if (!raw || typeof raw !== 'object') return raw;
 const ev = Object.assign({}, raw);
 // 1) normalize type
 let t = String(ev.type || ev.kind || ev.event || ev.action || '').toLowerCase().trim().replace(/[\s-]+/g, '_');
 for (const canon of Object.keys(PP_TYPE_ALIAS)) {
  if (PP_TYPE_ALIAS[canon].includes(t)) { t = canon; break; }
 }
 ev.type = t;
 // 2) normalize fields
 for (const canon of Object.keys(PP_FIELD_ALIAS)) {
  if (ev[canon] !== undefined && ev[canon] !== null && ev[canon] !== '') continue;
  for (const alt of PP_FIELD_ALIAS[canon]) {
   if (alt === canon) continue;
   if (ev[alt] !== undefined && ev[alt] !== null && ev[alt] !== '') { ev[canon] = ev[alt]; break; }
  }
 }
 // 3) เดา direction จากคำพูด
 if (ev.type === 'wallet' && !ev.direction) {
  const s = JSON.stringify(raw).toLowerCase();
  if (/(ได้รับ|โอนมา|โอนให้ฉัน|เข้าบัญชี|received|incoming|refund|paid me|sent me)/.test(s)) ev.direction = 'in';
  else if (/(จ่าย|โอนออก|หัก|ใช้ไป|paid|spent|outgoing|charge)/.test(s)) ev.direction = 'out';
 }
 // 4) headline/body → text
 if (!ev.text && (ev.headline || ev.title)) {
  ev.text = [ev.headline || ev.title, ev.body, ev.detail].filter(Boolean);
 }
 // 5) nested payload (บางโมเดลห่อไว้ใน data/payload)
 if (!ev.text && ev.data && typeof ev.data === 'object') {
  const inner = ppNormalizeSyncEvent(Object.assign({ type: ev.type }, ev.data));
  return inner;
 }
 // ★ 1.4.0 กู้เสียง: บอทเล่าว่าส่งคลิปเสียงแต่ส่ง dm มา → แปลงเป็นฟองเสียงให้
 if (ev.type === 'dm') {
  const hay = `${ev.voiceNote || ''} ${ev.format || ''} ${ev.medium || ''} ${ev.note || ''} ${ev.style || ''}`.toLowerCase();
  const flagged = ev.isVoice === true || ev.voice === true || /voice|audio|vn|เสียง|อัดเสียง|คลิปเสียง/.test(hay);
  if (flagged) ev.type = 'voice';
 }
 // เดา letUserPeek สำหรับ unsend ถ้าไม่ได้ระบุ
 if (ev.type === 'unsend' && ev.letUserPeek === undefined) {
  const s = JSON.stringify(raw).toLowerCase();
  ev.letUserPeek = !/hide|secret|ไม่ให้เห็น|ปิดบัง/.test(s);
 }
 return ev;
}
/** ★ 1.4.5 เข้มเฉพาะกับตัวละครหลักที่เปิดอยู่ · NPC ใหม่เกิดได้ตามปกติ
 * บทเรียนจาก 1.4.3: การจับชื่อแบบบางส่วนด้วยเกณฑ์สั้น ทำให้ NPC ใหม่ถูกเหมาเข้าคนเดิม */
function ppSyncFindContact(name, create) {
 let nm = String(name || '').trim();
 if (!nm) return null;
 nm = nm.replace(/^@/, '').replace(/^(คุณ|พี่|น้อง|นาย|นาง|นางสาว)\s+/i, '').trim();
 if (!nm) return null;
 const norm = s => String(s || '').toLowerCase().replace(/\s+/g, '').replace(/[‘’'"`\-_.]/g, '');
 const target = norm(nm);
 if (!target) return null;

 // 1) ตรงตัวเป๊ะ
 let c = getContacts().find(x => x.id === nm || dname(x) === nm);
 if (c) return c;
 // 2) ตรงหลังตัดช่องว่างและเครื่องหมาย
 c = getContacts().find(x => norm(dname(x)) === target);
 if (c) return c;
 // 3) ตรงกับชื่อจริงในการ์ด (เผื่อผู้ใช้ตั้ง customName ทับ)
 c = getContacts().find(x => norm(x.name) === target);
 if (c) return c;

 // 4) ★ กันตัวหลักตกชั้น — เข้มเฉพาะตัวละคร ST ที่เปิดอยู่ตัวเดียว
 const scopeId = currentCharacterId();
 if (scopeId) {
  const scopeChar = listStCharacters().find(x => x.id === scopeId);
  if (scopeChar) {
   const sn = norm(scopeChar.name);
   // ยอมรับเฉพาะกรณีที่ชื่อยาวใกล้เคียงกัน และเป็นส่วนหนึ่งของกันจริง
   const lenOk = sn.length >= 3 && target.length >= 3 && Math.abs(sn.length - target.length) <= 6;
   const hit = sn === target || (lenOk && (sn.includes(target) || target.includes(sn)));
   if (hit) {
    const existing = getContacts().find(x => x.id === scopeId);
    if (existing) return existing;
    if (!create) return null;
    const fresh = { id: scopeChar.id, name: scopeChar.name, avatar: scopeChar.avatar };
    getCfg().contacts.push(fresh);
    saveCfg();
    return fresh;
   }
  }
 }

 // 5) ★ เทียบกับตัวละครใน ST แบบตรงเป๊ะเท่านั้น — ไม่ใช้ includes อีกแล้ว
 const st = listStCharacters().find(x => norm(x.name) === target);
 if (st) {
  const existing = getContacts().find(x => x.id === st.id);
  if (existing) return existing;
  if (!create) return null;
  const fresh = { id: st.id, name: st.name, avatar: st.avatar };
  getCfg().contacts.push(fresh);
  saveCfg();
  return fresh;
 }

 // 6) ★ จับบางส่วนในคอนแทกต์เดิม — เกณฑ์เข้มขึ้นมาก กัน NPC ใหม่ถูกกลืน
 //    ต้องยาว 5 ตัวอักษรขึ้นไป และความยาวต่างกันไม่เกิน 4 ตัว
 if (target.length >= 5) {
  const partial = getContacts()
   .map(x => ({ x, dn: norm(dname(x)) }))
   .filter(o => o.dn.length >= 5 && Math.abs(o.dn.length - target.length) <= 4
    && (o.dn.includes(target) || target.includes(o.dn)))
   .sort((a, b) => b.dn.length - a.dn.length)[0];
  if (partial) return partial.x;
 }

 if (!create) return null;
 // 7) ถึงตรงนี้คือคนใหม่จริง สร้างเป็น NPC
 const npc = { id: 'npc:' + newId(), name: nm.slice(0, 80), avatar: '', npc: true, ownerCharId: scopeId || '' };
 getCfg().contacts.push(npc);
 saveCfg();
 return npc;
}
function ppSyncFindGroup(name, members) {
 const nm = String(name || '').trim();
 let g = getGroups().find(x => x.id === nm || x.name === nm)
  || getGroups().find(x => nm && (x.name.includes(nm) || nm.includes(x.name)));
 if (g || !nm) return g || null;
 const memberIds = (Array.isArray(members) ? members : []).map(x => ppSyncFindContact(x, true)).filter(Boolean).map(x => x.id);
 const unique = [...new Set(memberIds)];
 if (unique.length < 2) return null;
 g = { id: 'grp:' + newId(), name: nm.slice(0, 80), members: unique, knowEachOther: true, replyMode: 'many', cooldownSec: 0, warnNote: '' };
 getCfg().groups.push(g);
 saveCfg();
 return g;
}
function ppSyncLatestPost(ev) {
 if (ev && ev.postId) return findPost(String(ev.postId));
 const posts = getFeedPosts();
 if (ev && ev.postBy) {
  const author = ppSyncFindContact(ev.postBy, false);
  const aid = author ? author.id : (String(ev.postBy).toLowerCase() === 'user' ? 'user' : '');
  if (aid) return posts.slice().reverse().find(p => p.author === aid) || null;
 }
 return posts.slice().reverse().find(p => p.author === 'user') || posts[posts.length - 1] || null;
}
/** ★ 1.3.0 event ประเภทนี้อยู่ในโมดูลที่เปิดไหม */
function ppSyncTypeAllowed(type) {
 const m = {
  contact: 'msg', dm: 'msg', voice: 'msg', sticker: 'msg', location: 'msg', gift: 'msg', poll: 'msg', unsend: 'msg', story_reply: 'msg', nickname: 'msg',
  group: 'groupcall', group_message: 'groupcall', groupchat: 'groupcall', call: 'groupcall', missed_call: 'groupcall', call_log: 'groupcall', group_create: 'groupcall',
  wallet_set: 'wallet',
  post: 'feed', feed_post: 'feed', comment: 'feed', comment_reply: 'feed', like: 'feed', unlike: 'feed', save_post: 'feed', repost: 'feed', poll_vote: 'feed',
  story: 'story', story_like: 'story',
  wallet: 'wallet', payment: 'wallet', money: 'wallet', wallet_request: 'wallet', money_request: 'wallet',
  follow: 'social', follow_request: 'social', unfollow: 'social', note: 'social', status: 'social',
  news: 'news',
 }[type];
 if (!m) return true; // ไม่รู้จัก ปล่อยให้ตัวจัดการเดิมตอบว่า unsupported
 return bridgeOn(m);
}
function ppApplySyncEvent(rawEv) {
 const ev = ppNormalizeSyncEvent(rawEv);
 if (!ev || typeof ev !== 'object') return { ok: false, reason: 'ไม่ใช่ object' };
 const type = String(ev.type || ev.kind || '').toLowerCase().replace(/[\s-]+/g, '_');
 const cfg = getCfg();
 if (type === 'noop' || type === 'none' || !type) return { ok: false, noop: true };
 if (!ppSyncTypeAllowed(type)) return { ok: false, reason: `โมดูลปิดอยู่: ${type}`, blocked: true };

 // ── คอนแทกต์ใหม่ ──
 if (type === 'contact') {
  const c = ppSyncFindContact(ev.name || ev.from, true);
  return c ? { ok: true, label: `เพิ่ม ${dname(c)}` } : { ok: false, reason: 'ไม่ได้ระบุชื่อ' };
 }

 // ── ข้อความทุกชนิดในแชทเดี่ยว ──
 if (['dm', 'voice', 'sticker', 'location', 'gift', 'poll', 'unsend', 'nickname'].includes(type)) {
  const c = ppSyncFindContact(ev.from || ev.contact || ev.name, true);
  if (!c) return { ok: false, reason: 'ไม่รู้ว่าใครส่ง' };

  if (type === 'unsend') {
   const th = getThread(c.id);
   let old = th.slice().reverse().find(x => x.from === 'them' && !x.unsent && x.type !== 'call' && x.type !== 'transfer');
   const declared = ppSyncTextLines(ev.text, 1)[0] || '';
   if (!old && declared) {
    pushThreadMsg(c.id, { from: 'them', text: declared });
    old = getThread(c.id).slice(-1)[0];
   }
   if (!old) return { ok: false, reason: 'ไม่มีข้อความให้ยกเลิก และไม่ได้บอกเนื้อหามา' };
   old.unsent = true;
   old.origText = declared || old.text || old.label || '';
   old.letUserPeek = ev.letUserPeek !== false && cfg.unsendPeekEnabled !== false;
   old.unsentAt = Date.now();
   saveCfg();
   bumpUnread(c.id, 1);
   pushNotif(c.id, 'msg', `${dname(c)} ยกเลิกข้อความ`);
   islandNotify(c, 'ยกเลิกข้อความแล้ว');
   return { ok: true, label: `${dname(c)} ยกเลิกข้อความ` };
  }

  if (type === 'nickname') {
   const nick = ppSyncTextLines(ev.text, 1)[0];
   if (!nick) return { ok: false, reason: 'ไม่ได้ระบุชื่อเล่น' };
   const stored = findContact(c.id);
   if (!stored) return { ok: false, reason: 'ไม่พบคอนแทกต์' };
   if ((stored.userNickname || '') === nick) return { ok: false, noop: true };
   stored.userNickname = nick.slice(0, 60);
   stored.userNicknameAt = Date.now();
   saveCfg();
   if (cfg.nicknameNotify !== false) {
    pushThreadMsg(c.id, { from: 'sys', type: 'nickname', text: `${dname(c)} บันทึกชื่อคุณไว้ว่า "${stored.userNickname}"` });
    bumpUnread(c.id, 1);
    pushNotif(c.id, 'msg', `${dname(c)} เปลี่ยนชื่อที่บันทึกคุณไว้`);
    islandNotify(c, `บันทึกคุณว่า "${stored.userNickname}"`);
   }
   return { ok: true, label: `${dname(c)} ตั้งชื่อคุณว่า "${stored.userNickname}"` };
  }

  const made = [];
  if (type === 'voice') {
   const text = ppSyncTextLines(ev.text, 1)[0];
   if (text) made.push({ from: 'them', type: 'voice', text, dur: Math.min(60, Math.max(2, parseInt(ev.duration, 10) || Math.round(text.length / 8))) });
  } else if (type === 'sticker') {
   const found = findStickerByLabel(String(ev.label || ev.text || '').trim());
   const url = String(ev.url || (found && found.url) || '').trim();
   if (url) made.push({ from: 'them', type: 'sticker', url, label: String(ev.label || (found && found.label) || '').slice(0, 80) });
   else return { ok: false, reason: `ไม่พบสติกเกอร์ชื่อ "${String(ev.label || ev.text || '').slice(0, 30)}"` };
  } else if (type === 'location') {
   const place = String(ev.place || ev.text || '').trim();
   if (place) made.push({ from: 'them', type: 'location', place: place.slice(0, 120), note: String(ev.note || '').slice(0, 160) });
  } else if (type === 'gift') {
   const giftName = String(ev.gift || ev.name || ev.text || '').trim();
   if (giftName) made.push({ from: 'them', type: 'gift', giftName: giftName.slice(0, 100) });
  } else if (type === 'poll') {
   const question = String(ev.question || ev.text || '').trim();
   const options = (Array.isArray(ev.options) ? ev.options : []).map(x => String(x).trim()).filter(Boolean).slice(0, 6);
   if (question && options.length >= 2) made.push({ from: 'them', type: 'poll', question: question.slice(0, 180), options: options.map(t => ({ text: t.slice(0, 100), votes: [] })) });
  } else {
   ppSyncTextLines(ev.text || ev.messages, 12).forEach(text => made.push({ from: 'them', text }));
  }
  if (!made.length) return { ok: false, reason: `${type} ไม่มีเนื้อหา` };
  made.forEach(x => pushThreadMsg(c.id, x));
  bumpUnread(c.id, made.length);
  const prev = made[0].text || `[${type}]`;
  pushNotif(c.id, 'msg', prev);
  islandNotify(c, prev);
  return { ok: true, label: `${type} จาก ${dname(c)}` };
 }

 // ── ตอบสตอรี่ ──
 if (type === 'story_reply') {
  const c = ppSyncFindContact(ev.from || ev.contact || ev.name, true);
  const text = ppSyncTextLines(ev.text, 2)[0];
  const story = (cfg.stories || []).find(x => x.id === ev.storyId) || (cfg.stories || []).slice().reverse().find(x => x.author === 'user');
  if (!c || !text || !story) return { ok: false, reason: 'ไม่มีสตอรี่ คนตอบ หรือข้อความ' };
  pushThreadMsg(c.id, { from: 'them', text, replyTo: { kind: 'story', text: story.text || '[สตอรี่รูป]' } });
  if (!story.replies) story.replies = [];
  story.replies.push({ cid: c.id, text, ts: Date.now() });
  bumpUnread(c.id, 1);
  pushNotif(c.id, 'story', `${dname(c)} ตอบสตอรี่`);
  islandNotify(c, text);
  return { ok: true, label: `ตอบสตอรี่จาก ${dname(c)}` };
 }

 // ── กลุ่ม ──
 if (type === 'group' || type === 'group_message' || type === 'groupchat') {
  const g = ppSyncFindGroup(ev.group || ev.groupName || ev.name, ev.members);
  const c = ppSyncFindContact(ev.from || ev.sender, true);
  const lines = ppSyncTextLines(ev.text || ev.messages, 12);
  if (!g) return { ok: false, reason: 'ไม่พบกลุ่มนี้ และสร้างใหม่ไม่ได้ (ต้องมีสมาชิก 2 คน)' };
  if (!c || !lines.length) return { ok: false, reason: 'ไม่รู้ว่าใครพูด หรือไม่มีข้อความ' };
  if (!(g.members || []).includes(c.id)) g.members.push(c.id);
  lines.forEach(text => pushThreadMsg(g.id, { from: 'them', sender: c.id, senderName: dname(c), text }));
  bumpUnread(g.id, lines.length);
  pushNotif(g.id, 'group', `${dname(c)}: ${lines[0]}`);
  islandNotify({ id: g.id, name: g.name, avatar: '' }, `${dname(c)}: ${lines[0]}`);
  return { ok: true, label: `กลุ่ม ${g.name}` };
 }

 // ── สร้างกลุ่มใหม่ ──
 if (type === 'group_create') {
  if (cfg.botCanMakeGroup === false) return { ok: false, reason: 'ปิดไม่ให้บอทสร้างกลุ่ม', blocked: true };
  const nm = String(ev.group || ev.name || '').trim();
  if (!nm) return { ok: false, reason: 'ไม่ได้ตั้งชื่อกลุ่ม' };
  const memberIds = (Array.isArray(ev.members) ? ev.members : []).map(x => ppSyncFindContact(x, true)).filter(Boolean).map(x => x.id);
  const starter = ppSyncFindContact(ev.from || ev.sender, true);
  if (starter && !memberIds.includes(starter.id)) memberIds.unshift(starter.id);
  const unique = [...new Set(memberIds)];
  if (unique.length < 2) return { ok: false, reason: 'ต้องมีสมาชิกอย่างน้อย 2 คน' };
  let g = getGroups().find(x => x.name === nm);
  if (!g) {
   g = { id: 'grp:' + newId(), name: nm.slice(0, 80), members: unique, knowEachOther: true, replyMode: 'many', cooldownSec: 0, warnNote: '' };
   cfg.groups.push(g);
  } else {
   unique.forEach(id => { if (!g.members.includes(id)) g.members.push(id); });
  }
  pushThreadMsg(g.id, { from: 'sys', type: 'sysline', text: `${starter ? dname(starter) : 'ใครบางคน'} สร้างกลุ่มนี้และเพิ่มคุณเข้ามา` });
  ppSyncTextLines(ev.text, 6).forEach(text => {
   pushThreadMsg(g.id, { from: 'them', sender: starter ? starter.id : unique[0], senderName: starter ? dname(starter) : cname(unique[0]), text });
  });
  bumpUnread(g.id, 1);
  pushNotif(g.id, 'group', `ถูกเพิ่มเข้ากลุ่ม ${g.name}`);
  islandNotify({ id: g.id, name: g.name, avatar: '' }, 'คุณถูกเพิ่มเข้ากลุ่ม');
  saveCfg();
  return { ok: true, label: `สร้างกลุ่ม ${g.name}` };
 }

 // ── โทร ──
 if (type === 'call' || type === 'missed_call' || type === 'call_log') {
  const c = ppSyncFindContact(ev.from || ev.contact || ev.name, true);
  if (!c) return { ok: false, reason: 'ไม่รู้ว่าใครโทร' };
  const live = type === 'call' && ev.live !== false && !ppCall;
  if (live) { ppIncomingCall(c); return { ok: true, label: `สายเข้าจาก ${dname(c)}` }; }
  const missed = type === 'missed_call' || ev.missed === true;
  const count = missed ? Math.max(1, Math.min(10, parseInt(ev.count, 10) || 1)) : 1;
  const mins = Math.max(1, Math.min(180, parseInt(ev.minutes, 10) || 1));
  const transcript = ppSyncTextLines(ev.transcript, 12).map(text => ({ from: 'them', text }));
  if (!cfg.callLog) cfg.callLog = [];
  for (let i = 0; i < count; i++) {
   const ts = Date.now() - (count - i) * 60000;
   cfg.callLog.push({ cid: c.id, name: dname(c), avatar: c.avatar, chatId: ppStChatId(), startISO: new Date(ts).toISOString(), durText: missed ? 'ไม่ได้รับสาย' : fmtDur(mins * 60), incoming: true, transcript, missed });
   pushThreadMsg(c.id, { from: 'them', type: 'call', dir: 'in', missed, text: missed ? 'ไม่ได้รับสาย' : `คุยกัน ${fmtDur(mins * 60)}`, ts });
  }
  const th2 = getThread(c.id);
  th2.sort((a, b) => (a.ts || 0) - (b.ts || 0));
  saveCfg();
  bumpUnread(c.id, count);
  const lb = missed ? `สายที่ไม่ได้รับ ${count} สาย` : `คุยสาย ${fmtDur(mins * 60)}`;
  pushNotif(c.id, 'msg', lb);
  islandNotify(c, lb);
  return { ok: true, label: `${lb} · ${dname(c)}` };
 }

 // ── ข่าว ──
 if (type === 'news') {
  const text = ppSyncTextLines(ev.text || [ev.headline, ev.body], 6).join('\n');
  const source = String(ev.source || ev.author || 'ข่าวในโลก').trim().slice(0, 60);
  if (!text) return { ok: false, reason: 'ไม่มีเนื้อข่าว' };
  cfg.feedPosts.push({ id: newId(), author: 'news', kind: 'news', newsSource: source, authorName: source, handle: source, text: text.slice(0, 1000), mediaKeys: [], captions: [], visibility: 'all', ts: Date.now(), likes: [], extraLikes: Math.max(0, parseInt(ev.likes, 10) || 0), comments: [], views: {}, saves: 0 });
  pushNotif('news', 'feed', `${source}: ${text.split('\n')[0].slice(0, 60)}`);
  saveCfg();
  return { ok: true, label: `ข่าวจาก ${source}` };
 }

 // ── โพสต์ ──
 if (type === 'post' || type === 'feed_post') {
  const c = ppSyncFindContact(ev.author || ev.from || ev.name, true);
  const text = ppSyncTextLines(ev.text, 6).join('\n');
  if (!c || !text) return { ok: false, reason: 'ไม่รู้ว่าใครโพสต์ หรือไม่มีเนื้อหา' };
  const poll = ev.poll && Array.isArray(ev.poll.options)
   ? { question: String(ev.poll.question || '').slice(0, 180), options: ev.poll.options.slice(0, 6).map(x => ({ text: String(x).slice(0, 100), votes: [] })) }
   : null;
  cfg.feedPosts.push({ id: newId(), author: c.id, kind: 'post', authorName: dname(c), text: text.slice(0, 1000), mediaKeys: [], captions: [], responders: null, knowEachOther: true, visibility: ['all', 'followers', 'close', 'none'].includes(ev.visibility) ? ev.visibility : 'all', closeOnly: ev.closeOnly === true, poll, question: String(ev.question || '').slice(0, 180), ts: Date.now(), likes: [], extraLikes: Math.max(0, parseInt(ev.likes, 10) || 0), comments: [], views: {}, saves: 0 });
  pushNotif(c.id, 'feed', `${dname(c)} โพสต์ใหม่`);
  islandNotify(c, `${dname(c)} โพสต์ใหม่`);
  saveCfg();
  return { ok: true, label: `โพสต์ของ ${dname(c)}` };
 }

 // ── สตอรี่ ──
 if (type === 'story') {
  const c = ppSyncFindContact(ev.author || ev.from || ev.name, true);
  const text = ppSyncTextLines(ev.text, 3).join('\n');
  if (!c || !text) return { ok: false, reason: 'ไม่รู้ว่าใครลง หรือไม่มีเนื้อหา' };
  cfg.stories.push({ id: newId(), author: c.id, authorName: dname(c), type: 'text', text: text.slice(0, 220), bg: STORY_BGS[Math.floor(Math.random() * STORY_BGS.length)], closeOnly: ev.closeOnly === true, ts: Date.now(), likes: [], views: {}, replies: [] });
  pushNotif(c.id, 'story', `${dname(c)} ลงสตอรี่ใหม่`);
  islandNotify(c, 'ลงสตอรี่ใหม่');
  saveCfg();
  return { ok: true, label: `สตอรี่ของ ${dname(c)}` };
 }

 // ── คอมเมนต์ ──
 if (type === 'comment' || type === 'comment_reply') {
  const c = ppSyncFindContact(ev.author || ev.from || ev.name, true);
  const p = ppSyncLatestPost(ev);
  const text = ppSyncTextLines(ev.text, 2)[0];
  if (!c || !p || !text) return { ok: false, reason: 'ไม่รู้ว่าใครคอมเมนต์ โพสต์ไหน หรือไม่มีข้อความ' };
  if (!p.comments) p.comments = [];
  const parent = ev.parentId || ev.replyTo;
  const parentId = parent && p.comments.some(x => x.id === parent) ? parent : null;
  p.comments.push({ id: newId(), author: c.id, text, ts: Date.now(), likes: [], extraLikes: Math.max(0, parseInt(ev.likes, 10) || 0), parentId });
  pushNotif(c.id, 'comment', `${dname(c)} คอมเมนต์: ${text.slice(0, 40)}`);
  saveCfg();
  return { ok: true, label: `คอมเมนต์จาก ${dname(c)}` };
 }

 // ── ไลก์ / บันทึก / ถูกใจสตอรี่ ──
 if (['like', 'unlike', 'save_post', 'story_like'].includes(type)) {
  const c = ppSyncFindContact(ev.from || ev.author || ev.name, true);
  if (!c) return { ok: false, reason: 'ไม่รู้ว่าใครกด' };
  if (type === 'story_like') {
   const story = (cfg.stories || []).find(x => x.id === ev.storyId) || (cfg.stories || []).slice().reverse().find(x => x.author === 'user');
   if (!story) return { ok: false, reason: 'ไม่พบสตอรี่' };
   if (!story.likes) story.likes = [];
   if (!story.likes.includes(c.id)) story.likes.push(c.id);
   saveCfg();
   pushNotif(c.id, 'story', `${dname(c)} ถูกใจสตอรี่ของคุณ`);
   return { ok: true, label: `${dname(c)} ถูกใจสตอรี่` };
  }
  const p = ppSyncLatestPost(ev);
  if (!p) return { ok: false, reason: 'ไม่พบโพสต์' };
  if (!p.likes) p.likes = [];
  if (type === 'unlike') p.likes = p.likes.filter(x => x !== c.id);
  else if (type === 'save_post') p.saves = (p.saves || 0) + 1;
  else if (!p.likes.includes(c.id)) p.likes.push(c.id);
  saveCfg();
  pushNotif(c.id, 'feed', `${dname(c)} ${type === 'save_post' ? 'บันทึก' : type === 'unlike' ? 'เลิกถูกใจ' : 'ถูกใจ'}โพสต์`);
  return { ok: true, label: `${type} โดย ${dname(c)}` };
 }

 // ── รีโพสต์ ──
 if (type === 'repost') {
  const c = ppSyncFindContact(ev.author || ev.from || ev.name, true);
  const src = ppSyncLatestPost(ev);
  if (!c || !src) return { ok: false, reason: 'ไม่รู้ว่าใครรีโพสต์ หรือไม่พบโพสต์ต้นทาง' };
  const root = rootPost(src);
  cfg.feedPosts.push({ id: newId(), author: c.id, authorName: dname(c), kind: 'post', repostOf: root.id, quote: String(ev.quote || '').slice(0, 400), text: '', mediaKeys: [], captions: [], visibility: 'all', ts: Date.now(), likes: [], extraLikes: 0, comments: [], views: {}, saves: 0 });
  saveCfg();
  pushNotif(c.id, 'feed', `${dname(c)} รีโพสต์`);
  return { ok: true, label: `รีโพสต์โดย ${dname(c)}` };
 }

 // ── โหวตโพล ──
 if (type === 'poll_vote') {
  const c = ppSyncFindContact(ev.from || ev.author || ev.name, true);
  const p = ppSyncLatestPost(ev);
  const oi = Math.max(0, parseInt(ev.option, 10) || 0);
  if (!c) return { ok: false, reason: 'ไม่รู้ว่าใครโหวต' };
  if (!p || !p.poll || !p.poll.options || !p.poll.options[oi]) return { ok: false, reason: 'ไม่พบโพลหรือตัวเลือกนั้น' };
  p.poll.options.forEach(x => { x.votes = (x.votes || []).filter(v => v !== c.id); });
  p.poll.options[oi].votes.push(c.id);
  saveCfg();
  pushNotif(c.id, 'feed', `${dname(c)} โหวตในโพล`);
  return { ok: true, label: `โหวตโดย ${dname(c)}` };
 }

 // ── เงิน ──
 if (type === 'wallet' || type === 'payment' || type === 'money') {
  const amount = Math.abs(parseInt(ev.amount, 10) || 0);
  if (!amount) return { ok: false, reason: 'ไม่ได้ระบุจำนวนเงิน' };
  const hasWho = !!(ev.from || ev.contact || ev.name);
  const c = ppSyncFindContact(ev.from || ev.contact || ev.name, hasWho);
  const incoming = !ev.direction || /^(in|income|earn|received|incoming)$/i.test(String(ev.direction));
  const note = String(ev.reason || ev.note || 'จากเนื้อเรื่อง').slice(0, 160);
  adjustUserBalance(incoming ? amount : -amount);
  pushWalletHistory(incoming ? 'in' : 'out', amount, c ? c.id : null, c ? dname(c) : (incoming ? 'รายได้' : 'รายจ่าย'), note);
  if (c) {
   setBotWallet(c.id, getBotWallet(c.id) + (incoming ? -amount : amount));
   pushThreadMsg(c.id, { from: incoming ? 'them' : 'me', type: 'transfer', amount, note, status: 'accepted' });
   bumpUnread(c.id, 1);
   pushNotif(c.id, 'wallet', `${incoming ? 'ได้รับโอน' : 'โอนออก'} ${fmtMoney(amount)}`);
   islandNotify(c, `${incoming ? 'โอนเงินให้คุณ' : 'คุณจ่ายไป'} ${fmtMoney(amount)}`);
  }
  saveCfg();
  return { ok: true, label: `${incoming ? 'รับ' : 'จ่าย'} ${fmtMoney(amount)}${c ? ` · ${dname(c)}` : ''}` };
 }

 // ── ขอเงิน ──
 if (type === 'wallet_request' || type === 'money_request') {
  const c = ppSyncFindContact(ev.from || ev.contact || ev.name, true);
  const amount = Math.abs(parseInt(ev.amount, 10) || 0);
  const note = String(ev.reason || ev.note || '').slice(0, 160);
  if (!c || !amount) return { ok: false, reason: 'ไม่รู้ว่าใครขอ หรือไม่ระบุจำนวน' };
  const text = `ขอเงิน ${fmtMoney(amount)}${note ? ` — ${note}` : ''}`;
  pushThreadMsg(c.id, { from: 'them', text });
  bumpUnread(c.id, 1);
  pushNotif(c.id, 'wallet', text);
  islandNotify(c, text);
  return { ok: true, label: `คำขอเงินจาก ${dname(c)}` };
 }

 // ── บอทกำหนดยอดเงินตัวเอง ──
 if (type === 'wallet_set') {
  if (cfg.botCanSetWallet === false) return { ok: false, reason: 'ปิดไม่ให้บอทกำหนดยอดเงินตัวเอง', blocked: true };
  const c = ppSyncFindContact(ev.from || ev.contact || ev.name, true);
  const amount = Math.max(0, parseInt(ev.amount, 10) || 0);
  if (!c) return { ok: false, reason: 'ไม่รู้ว่าเป็นยอดเงินของใคร' };
  const before = getBotWallet(c.id);
  setBotWallet(c.id, amount);
  const reason = String(ev.reason || ev.note || '').slice(0, 120);
  return { ok: true, label: `ยอดเงินของ ${dname(c)} ${fmtMoney(before)} → ${fmtMoney(amount)}${reason ? ` (${reason})` : ''}` };
 }

 // ── ติดตาม ──
 if (type === 'follow' || type === 'follow_request') {
  const c = ppSyncFindContact(ev.from || ev.contact || ev.name, true);
  if (!c) return { ok: false, reason: 'ไม่รู้ว่าใครติดตาม' };
  if (cfg.accountLocked || type === 'follow_request') {
   if (!cfg.followRequests.includes(c.id) && !cfg.followers.includes(c.id)) cfg.followRequests.push(c.id);
   pushNotif(c.id, 'follow', `${dname(c)} ขอติดตามคุณ`);
  } else {
   if (!cfg.followers.includes(c.id)) cfg.followers.push(c.id);
   pushNotif(c.id, 'follow', `${dname(c)} เริ่มติดตามคุณ`);
  }
  saveCfg();
  return { ok: true, label: `${dname(c)} ติดตาม` };
 }
 if (type === 'unfollow') {
  const c = ppSyncFindContact(ev.from || ev.contact || ev.name, false);
  if (!c) return { ok: false, reason: 'ไม่พบคอนแทกต์นี้' };
  cfg.followers = (cfg.followers || []).filter(x => x !== c.id);
  cfg.followRequests = (cfg.followRequests || []).filter(x => x !== c.id);
  saveCfg();
  pushNotif(c.id, 'follow', `${dname(c)} เลิกติดตาม`);
  return { ok: true, label: `${dname(c)} เลิกติดตาม` };
 }

 // ── สเตตัส ──
 if (type === 'note' || type === 'status') {
  const c = ppSyncFindContact(ev.author || ev.from || ev.name, true);
  const text = ppSyncTextLines(ev.text, 1)[0];
  if (!c) return { ok: false, reason: 'ไม่รู้ว่าใครลงสเตตัส' };
  setBotNote(c.id, text || '');
  return { ok: true, label: `สเตตัสของ ${dname(c)}` };
 }

 return { ok: false, reason: `ไม่รู้จักประเภทนี้: ${type}` };
}
function ppApplySyncBatch(payload) {
 if (!payload || typeof payload !== 'object') return { valid: false, applied: 0, ignored: 0, detail: 'payload ไม่ใช่ object' };
 let list = Array.isArray(payload.events) ? payload.events
  : Array.isArray(payload) ? payload
  : Array.isArray(payload.data) ? payload.data
  : (payload.type ? [payload] : null);
 if (!list) return { valid: false, applied: 0, ignored: 0, detail: 'ไม่พบรายการ events' };
 const limit = Math.max(1, Math.min(20, getCfg().syncMaxEvents || 8));
 // ★ 1.4.3 กรองซ้ำในก้อนเดียวกัน — โมเดลชอบส่ง event เดิมหลายรอบ
 const seen = new Set();
 const deduped = [];
 let dupes = 0;
 list.forEach(ev => {
  if (!ev || typeof ev !== 'object') return;
  const t = String(ev.type || ev.kind || '?').toLowerCase();
  const who = String(ev.from || ev.author || ev.sender || ev.name || ev.group || '').toLowerCase().trim();
  const txt = JSON.stringify(ev.text || ev.messages || ev.amount || ev.label || ev.place || '').slice(0, 160).toLowerCase();
  const key = `${t}|${who}|${txt}`;
  if (seen.has(key)) { dupes++; return; }
  seen.add(key);
  deduped.push(ev);
 });
 const events = deduped.slice(0, limit);
 let applied = 0, ignored = 0, blocked = 0;
 const labels = [], errors = [];
 events.forEach(ev => {
  const t = String((ev && (ev.type || ev.kind)) || '?');
  try {
   const r = ppApplySyncEvent(ev);
   if (r.ok) { applied++; if (r.label) labels.push(r.label); ppPushSyncEvent(true, t, r.label || '', ''); }
   else if (r.noop) { /* เงียบ */ }
   else if (r.blocked) { blocked++; ppPushSyncEvent(false, t, '', r.reason || 'โมดูลปิด'); }
   else { ignored++; if (r.reason) errors.push(r.reason); ppPushSyncEvent(false, t, '', r.reason || 'ไม่ผ่าน'); }
  } catch (e) { ignored++; const msg = e && e.message ? e.message : 'event ล้มเหลว'; errors.push(msg); ppPushSyncEvent(false, t, '', msg); }
 });
 const over = Math.max(0, deduped.length - events.length);
 if (over) { ignored += over; errors.push(`เกินเพดาน ${over} รายการ`); ppPushSyncEvent(false, 'overflow', '', `เกินเพดาน ${over} รายการ`); }
 if (dupes) ppPushSyncEvent(false, 'duplicate', '', `กรองรายการซ้ำออก ${dupes} รายการ`);
 saveCfg();
 ppRefreshAllViews();
 const bits = [];
 if (labels.length) bits.push(labels.join(', '));
 if (dupes) bits.push(`ซ้ำ ${dupes}`);
 if (blocked) bits.push(`ปิดโมดูลกัน ${blocked}`);
 if (!labels.length && errors.length) bits.push(errors.join(', '));
 return { valid: true, applied, ignored, blocked, dupes, detail: bits.join(' · ').slice(0, 200) };
}
function ppSyncInventory() {
 const contacts = getContacts().filter(c => !isBlocked(c.id)).slice(0, 40).map(dname);
 const groups = getGroups().slice(0, 20).map(g => `${g.name}(${groupMemberContacts(g).map(dname).join(',')})`);
 const posts = getFeedPosts().slice(-6).map(p => `${p.id}:${p.kind}:${postAuthorLabel(p)}:${String(p.text || '[image]').replace(/\s+/g, ' ').slice(0, 90)}`);
 const stories = liveStories().slice(-5).map(s => `${s.id}:${s.author === 'user' ? getUserDisplayName() : cname(s.author)}:${String(s.text || '[image]').slice(0, 60)}`);
 return [`Contacts=${contacts.join(', ') || 'none'}`, `Groups=${groups.join('; ') || 'none'}`, `RecentPosts=${posts.join('; ') || 'none'}`, `LiveStories=${stories.join('; ') || 'none'}`, `UserWallet=${fmtMoney(walletBalanceGet())}`, `Account=${getCfg().accountLocked ? 'private' : 'public'}`].join('\n');
}
function ppMainChatUiState() {
 const cfg = getCfg();
 const activeId = (typeof ppActiveGroup !== 'undefined' && ppActiveGroup?.id)
  || (typeof ppActiveContact !== 'undefined' && ppActiveContact?.id) || '';
 const activeContact = activeId && !isGroupId(activeId) ? findContact(activeId) : null;
 const activeName = activeId && isGroupId(activeId)
  ? (getGroups().find(g => g.id === activeId)?.name || activeId)
  : (activeContact ? dname(activeContact) : activeId);
 const style = activeId && cfg.chatStyle && cfg.chatStyle[activeId] ? cfg.chatStyle[activeId] : {};
 return JSON.stringify({
  appearance: {
   theme: cfg.theme,
   accentColor: cfg.accent,
   wallpaper: cfg.wallpaper,
   homeBlur: cfg.homeBlur,
   dynamicIsland: cfg.dynamicIsland,
   compactHeader: cfg.headerCompact,
  },
  currentView: {
   screen: typeof ppCurrentScreen !== 'undefined' ? ppCurrentScreen : 'home',
   activeThread: activeName || null,
   activeChatStyle: {
    background: style.bg || style.background || null,
    bubbleColor: style.bubble || style.bubbleColor || null,
    textColor: style.textColor || null,
    glass: style.bubbleGlass ?? null,
    messageBlur: style.msgBlur ?? null,
    shape: style.tail || null,
   },
  },
  account: {
   displayName: getUserDisplayName(),
   handle: cfg.userHandle || null,
   privacy: cfg.accountLocked ? 'private' : 'public',
   defaultPostVisibility: cfg.postVisibilityDefault,
   closeFriends: (cfg.closeFriends || []).map(id => cname(id)).filter(Boolean).slice(0, 20),
  },
  phoneState: {
   wallet: fmtMoney(walletBalanceGet()),
   currency: cfg.walletCurrency,
   unreadNotifications: (cfg.notifCenter || []).filter(n => !n.seen).length,
   currentStatus: cfg.userNote?.text || cfg.userNote || null,
  },
 });
}

// ══════════════════════════════════════════════════════════
// BRIDGE — ephemeral prompt in, plain JSON frame out
// ══════════════════════════════════════════════════════════
/** ★ 1.4.4 ตัวกันซ้ำย้ายไปอยู่ที่ frame แล้ว (ppSyncFrameFingerprint) ที่นี่ไม่ต้องกันอีก */
window.ppGenInterceptor = function (chat, contextSize, abort, type) {
 try {
 const cfg = getCfg();
 const generationType = String(type || 'normal').toLowerCase();
 if (['quiet', 'impersonate', 'continue'].some(x => generationType.includes(x))) {
  ppBridgeExpected = false; ppCancelActionBatch(); return;
 }
 if (!Array.isArray(chat)) return;

 // ★ 1.4.4 กันแค่กรณี ST ส่ง chat ก้อนเดิมที่มี system ของเราติดมาแล้วจริง ๆ
 if (chat.some(m => m && m.name && /^PocketPhone(SyncV2|Activity)?$/.test(String(m.name)))) return;

 if (cfg.autoSyncEnabled !== false) {
  const actionBatch = ppPrepareActionBatch();
  ppBridgeExpected = true;
  ppPendingActionIds = actionBatch ? actionBatch.ids : null;
  const parts = ppBuildBridgeParts(actionBatch ? actionBatch.body : '');
  const modKeys = Object.keys(parts.mods);
  const eventMods = ['msg', 'groupcall', 'feed', 'story', 'wallet', 'social', 'news'].filter(bridgeOn);
  if (eventMods.length) {
   const instr = [parts.core].concat(modKeys.map(k => parts.mods[k])).join('\n');
   chat.push({ is_user: false, is_system: true, name: 'PocketPhoneSyncV2', mes: instr });
  } else {
   ppBridgeExpected = false;
  }
  if (parts.actionBody) {
   chat.push({ is_user: false, is_system: true, name: 'PocketPhoneActivity', mes: ppBuildActionMessage(parts.actionBody) });
  }
 } else {
  ppCancelActionBatch();
  ppBridgeExpected = false;
 }

 const period = periodPromptNote();
 if (period) chat.push({ is_user: false, is_system: true, name: 'PocketPhone', mes: `[Pocket Phone health context: ${period}]` });
 } catch (e) { ppBridgeExpected = false; ppCancelActionBatch(); console.warn('[pocket-phone] interceptor', e); }
};
// แปลงคำบอกเวลาย้อนหลังแบบหยาบ ๆ เป็น timestamp ("เมื่อคืน" "2 ชม." "3 วัน")
function ppAgoToTs(ago) {
 let ts = Date.now();
 const s = String(ago || '');
 const hourM = s.match(/(\d+)\s*(ชม|ชั่วโมง|hour)/i);
 const dayM = s.match(/(\d+)\s*(วัน|day)/i);
 if (/เมื่อคืน|last night|คืน/i.test(s)) ts -= 9 * 3600000;
 else if (hourM) ts -= (parseInt(hourM[1], 10) || 1) * 3600000;
 else if (dayM) ts -= (parseInt(dayM[1], 10) || 1) * 86400000;
 else ts -= 3600000;
 return ts;
}
// regex กลางสำหรับคีย์ [PP_...] และสแปนที่ใช้ห่อซ่อน
const PP_KEY_RE_G = /\[PP_(?:CALL|MSG|NEWCHAT|PAY|EARN|FOLLOW|MISSEDCALL|PASTMSG|PASTCALL|PASTPAY|REPLY):[^\]]*\]/gi;
const PP_KEY_RE_ONE = /\[PP_(?:CALL|MSG|NEWCHAT|PAY|EARN|FOLLOW|MISSEDCALL|PASTMSG|PASTCALL|PASTPAY|REPLY):[^\]]*\]/i;
const PP_WRAP_RE_G = /<span class="pp-hk"[^>]*>\s*\[PP_[^\]]*\]\s*<\/span>/gi;

// แกะสแปนออก เหลือคีย์เปล่า (กัน double-wrap)
function ppUnwrapKeys(text) {
 return String(text || '').replace(PP_WRAP_RE_G, m => { const km = m.match(PP_KEY_RE_ONE); return km ? km[0] : ''; });
}
// ห่อคีย์ทุกตัวด้วยสแปนซ่อน — คงตัวอักษรคีย์ไว้ในไฟล์ให้บอทย้อนอ่าน
function ppWrapKeys(text) {
 const bare = ppUnwrapKeys(text);
 return bare.replace(PP_KEY_RE_G, k => `<span class="pp-hk" style="display:none">${k}</span>`);
}
// ซ่อนคีย์ [PP_...] บนจอ โดยไม่แตะ last.mes (คีย์ยังอยู่ในไฟล์ให้บอทย้อนอ่าน + กดแก้ไขเห็น)
// ทำงานบน text node เท่านั้น กันพัง HTML เดิมของข้อความ
function ppHideKeysInDom(dom) {
 if (!dom) return;
 const rx = /\[PP_(?:CALL|MSG|NEWCHAT|PAY|EARN|FOLLOW|MISSEDCALL|PASTMSG|PASTCALL|PASTPAY|REPLY):[^\]]*\]/gi;
 const walker = document.createTreeWalker(dom, NodeFilter.SHOW_TEXT, null);
 const targets = [];
 let node;
 while ((node = walker.nextNode())) {
 rx.lastIndex = 0;
 if (node.parentNode && node.parentNode.classList && node.parentNode.classList.contains('pp-key-hidden')) continue;
 if (rx.test(node.nodeValue)) targets.push(node);
 }
 targets.forEach(n => {
 const s = n.nodeValue;
 const frag = document.createDocumentFragment();
 let last = 0, mm;
 rx.lastIndex = 0;
 while ((mm = rx.exec(s))) {
 if (mm.index > last) frag.appendChild(document.createTextNode(s.slice(last, mm.index)));
 const span = document.createElement('span');
 span.className = 'pp-key-hidden';
 span.style.display = 'none';
 span.textContent = mm[0];
 frag.appendChild(span);
 last = mm.index + mm[0].length;
 }
 if (last < s.length) frag.appendChild(document.createTextNode(s.slice(last)));
 n.parentNode.replaceChild(frag, n);
 });
}
// ลบคีย์ [PP_...] ออกจากข้อความบอทที่เก่ากว่า N เทิร์นล่าสุด (คงคีย์ไว้ใน N เทิร์นล่าสุดให้บอทย้อนอ่าน)
// ทำเฉพาะไฟล์ (last.mes) ไม่แตะ DOM — DOM จัดการด้วย ppHideKeysInDom แยก
async function ppSweepOldKeys() {
 try {
 const c = ctx();
 if (!c || !Array.isArray(c.chat) || !c.chat.length) return;
 const keep = Math.max(0, Math.min(20, getCfg().keyKeepTurns || 0));
 const botIdx = [];
 for (let i = c.chat.length - 1; i >= 0; i--) {
 const mm = c.chat[i];
 if (mm && !mm.is_user && !mm.is_system) botIdx.push(i);
 }
 const protectedSet = new Set(botIdx.slice(0, keep)); // N เทิร์นล่าสุด = คงไว้
 let dirty = false;
 c.chat.forEach((mm, i) => {
 if (!mm || typeof mm.mes !== 'string') return;
 if (protectedSet.has(i)) return;
 if (mm.mes.indexOf('[PP_') === -1) return;
 const cleaned = mm.mes
 .replace(PP_WRAP_RE_G, '') // ลบทั้งสแปน+คีย์
 .replace(PP_KEY_RE_G, '') // เผื่อคีย์เปล่าที่ไม่ได้ห่อ
 .replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
 if (cleaned !== mm.mes) { mm.mes = cleaned; dirty = true; }
 });
 if (dirty) await ppSaveChatNow();
 } catch (e) { console.warn('[pocket-phone] sweep old keys', e); }
}
async function ppHandleMainChatMessageLegacy() {
 try {
 const cfgNow = getCfg();
 if (!cfgNow.universeAffectsRP && cfgNow.autoSyncEnabled === false) return;
 const c = ctx();
 if (!c || !Array.isArray(c.chat) || !c.chat.length) return;
 const last = c.chat[c.chat.length - 1];
 if (!last || last.is_user) return;
 if (last && typeof last === 'object' && ppHandledMainObjects.has(last)) return;
 if (last && typeof last === 'object') ppHandledMainObjects.add(last);
 let mes = String(last.mes || '');
 let syncChanged = false;

 // Apply the hidden batch locally before the legacy key parser. No API call is
 // made here. Mark it DONE in the saved chat so reloads cannot replay money,
 // messages, or notifications.
 const syncInfo = ppExtractSyncBatch(mes);
 if (syncInfo.found) {
  if (syncInfo.error) ppRecordSyncReceipt('invalid', 0, 0, syncInfo.error);
  else {
   const result = ppApplySyncBatch(syncInfo.payload);
   if (!result.valid) ppRecordSyncReceipt('invalid', 0, result.ignored, result.detail);
   else if (result.applied > 0) ppRecordSyncReceipt('applied', result.applied, result.ignored, result.detail);
   else ppRecordSyncReceipt('noop', 0, result.ignored, result.detail);
  }
  mes = ppFinalizeSyncMarker(mes, syncInfo);
  last.mes = mes;
  syncChanged = true;
 } else if (cfgNow.autoSyncEnabled !== false && !PP_SYNC_DONE_RX.test(mes)) {
  ppRecordSyncReceipt('missing', 0, 0, 'model omitted the required batch');
 }
 // มี "คีย์ดิบ" (ยังไม่ถูกห่อ) ไหม = ยังไม่เคยประมวลผลข้อความนี้
 const withoutWrapped = mes.replace(PP_WRAP_RE_G, '');
 PP_KEY_RE_G.lastIndex = 0;
 const hasUnwrapped = PP_KEY_RE_G.test(withoutWrapped);
 PP_KEY_RE_G.lastIndex = 0;
 if (!hasUnwrapped) {
 // คีย์ถูกห่อครบแล้ว (หรือไม่มีคีย์) → ไฟล์ซ่อนให้เอง แค่เก็บกวาดคีย์เก่าแล้วจบ (กันยิงข้อความซ้ำ)
 if (syncChanged) {
  const idx = c.chat.length - 1;
  const dom = document.querySelector(`#chat .mes[mesid="${idx}"] .mes_text`);
  ppDetect();
  if (dom && PP_CAP.msgFormat) dom.innerHTML = c.messageFormatting(last.mes, last.name, false, false, idx);
  await ppSaveChatNow();
 }
 ppSweepOldKeys();
 updateHomeWidgets();
 return;
 }

 let m, dirty = false;
 const rxCall = /\[PP_CALL:\s*([^\]]+)\]/gi;
 while ((m = rxCall.exec(mes))) {
 const nm = m[1].trim();
 const c2 = getContacts().find(x => dname(x) === nm) || getContacts().find(x => nm.includes(dname(x)));
 if (c2 && !ppCall) { ppActiveContact = c2; ppActiveGroup = null; ppIncomingCall(c2); }
 }
 // จับทั้ง [PP_MSG:ชื่อ|ข้อความ] และ [PP_MSG:ชื่อ ข้อความ] (บอทมักลืมใส่ |)
 const rxMsg = /\[PP_MSG:\s*([^\]]+?)\]/gi;
 while ((m = rxMsg.exec(mes))) {
 const raw = m[1].trim();
 let nm = '', rest = '';
 if (raw.includes('|')) {
 const pipe = raw.indexOf('|');
 nm = raw.slice(0, pipe).trim();
 rest = raw.slice(pipe + 1).trim();
 } else {
 // ไม่มี | : เดาชื่อจากคอนแทกต์ที่ข้อความขึ้นต้นด้วย (ชื่อยาวสุดก่อน)
 const cand = getContacts()
 .map(x => ({ x, dn: dname(x) }))
 .filter(o => o.dn && o.dn.length >= 2 && (raw === o.dn || raw.startsWith(o.dn + ' ') || raw.startsWith(o.dn)))
 .sort((a, b) => b.dn.length - a.dn.length)[0];
 if (cand) { nm = cand.dn; rest = raw.slice(cand.dn.length).trim(); }
 else {
 const sp = raw.indexOf(' ');
 if (sp > 0) { nm = raw.slice(0, sp).trim(); rest = raw.slice(sp + 1).trim(); }
 else { nm = raw; rest = ''; }
 }
 }
 let c2 = getContacts().find(x => dname(x) === nm) || getContacts().find(x => nm && nm.includes(dname(x))) || getContacts().find(x => nm && dname(x).includes(nm));
 // ดัก: ไม่มีคอนแทกต์นี้ → สร้างให้เลย (โมเดลอาจใช้ PP_MSG แทน PP_NEWCHAT)
 if (!c2 && nm && rest) {
 const cfg2 = getCfg();
 const st = listStCharacters().find(x => x.name === nm);
 c2 = st ? { id: st.id, name: st.name, avatar: st.avatar } : { id: 'npc:' + newId(), name: nm, avatar: '', npc: true, ownerCharId: currentCharacterId() || '' };
 cfg2.contacts.push(c2);
 saveCfg();
 }
 if (!c2 || !rest) continue;
 // แยกเป็นหลาย bubble ตาม || หรือขึ้นบรรทัดใหม่ (ไม่ใช้ lookbehind กันมือถือพัง)
 let chunks = String(rest).split(/\s*(?:\|\||\n)\s*/).map(s => stripEmoji(s.trim())).filter(Boolean);
 if (chunks.length <= 1 && String(rest).length > 60) {
 // แยกประโยคโดยไม่ใช้ lookbehind (กัน Safari เก่าพัง)
 chunks = String(rest).replace(/([\.\!\?…。])\s+/g, '$1\u0001').split(/\u0001|\s{2,}/).map(s => stripEmoji(s.trim())).filter(Boolean);
 }
 const lines = chunks.length ? chunks : [stripEmoji(rest)];
 lines.forEach(txt => { if (txt) { pushThreadMsg(c2.id, { from: 'them', text: txt }); bumpUnread(c2.id, 1); } });
 if (lines[0]) pushNotif(c2.id, 'msg', lines[0]);
 if (ppViewing(c2.id)) renderThread(); else if (ppCurrentScreen === 'messages') renderContactList();
 if (lines[0]) islandNotify(c2, lines[0]);
 }
 const rxNew = /\[PP_NEWCHAT:\s*([^\]]+?)\]/gi;
 while ((m = rxNew.exec(mes))) {
 const rawN = m[1].trim();
 let nm = '', txt = '';
 if (rawN.includes('|')) {
 const pipe = rawN.indexOf('|');
 nm = rawN.slice(0, pipe).trim();
 txt = stripEmoji(rawN.slice(pipe + 1).trim());
 } else {
 const sp = rawN.indexOf(' ');
 if (sp > 0) { nm = rawN.slice(0, sp).trim(); txt = stripEmoji(rawN.slice(sp + 1).trim()); }
 else { nm = rawN; txt = ''; }
 }
 if (!nm) continue;
 let c2 = getContacts().find(x => dname(x) === nm);
 if (!c2) {
 const st = listStCharacters().find(x => x.name === nm);
 const cfg = getCfg();
 c2 = st ? { id: st.id, name: st.name, avatar: st.avatar } : { id: 'npc:' + newId(), name: nm, avatar: '', npc: true, ownerCharId: currentCharacterId() || '' };
 cfg.contacts.push(c2);
 saveCfg();
 }
 if (txt) {
 pushThreadMsg(c2.id, { from: 'them', text: txt });
 bumpUnread(c2.id, 1);
 pushNotif(c2.id, 'msg', txt);
 islandNotify(c2, `${dname(c2)}: ${txt}`);
 }
 if (ppCurrentScreen === 'messages') renderContactList();
 }
 // ── สายย้อนหลัง: [PP_MISSEDCALL:ชื่อ|จำนวนสาย|เวลาที่ผ่านมา] จำลองว่าเคยโทรมาแล้วผู้ใช้ไม่ได้รับ ──
 const rxMissed = /\[PP_MISSEDCALL:\s*([^\]]+?)\]/gi;
 while ((m = rxMissed.exec(mes))) {
 const parts = String(m[1]).split('|').map(s => s.trim());
 const nm = parts[0];
 if (!nm) continue;
 const count = Math.max(1, Math.min(20, parseInt(parts[1], 10) || 1));
 const ago = parts[2] || '';
 let c2 = getContacts().find(x => dname(x) === nm) || getContacts().find(x => nm.includes(dname(x)));
 if (!c2) {
 const cfg2 = getCfg();
 const st = listStCharacters().find(x => x.name === nm);
 c2 = st ? { id: st.id, name: st.name, avatar: st.avatar } : { id: 'npc:' + newId(), name: nm, avatar: '', npc: true, ownerCharId: currentCharacterId() || '' };
 cfg2.contacts.push(c2);
 saveCfg();
 }
 const cfg = getCfg();
 if (!cfg.callLog) cfg.callLog = [];
 // ย้อนเวลาตาม ago (รองรับ "เมื่อคืน" "2 ชม." ฯลฯ แบบหยาบ ๆ)
 let baseTs = Date.now();
 const hourM = ago.match(/(\d+)\s*(ชม|ชั่วโมง|hour)/i);
 const dayM = ago.match(/(\d+)\s*(วัน|day)/i);
 if (/เมื่อคืน|last night|คืน/i.test(ago)) baseTs -= 9 * 3600000;
 else if (hourM) baseTs -= (parseInt(hourM[1], 10) || 1) * 3600000;
 else if (dayM) baseTs -= (parseInt(dayM[1], 10) || 1) * 86400000;
 else baseTs -= 3600000;
 for (let i = 0; i < count; i++) {
 const ts = baseTs + i * Math.floor(Math.random() * 900000 + 120000);
 cfg.callLog.push({
 cid: c2.id, name: dname(c2), avatar: c2.avatar, chatId: ppStChatId(),
 startISO: new Date(ts).toISOString(), durText: 'ไม่ได้รับสาย', incoming: true, transcript: [], missed: true,
 });
 pushThreadMsg(c2.id, { from: 'them', type: 'call', dir: 'in', missed: true, text: 'ไม่ได้รับสาย', ts });
 }
 bumpUnread(c2.id, count);
 pushNotif(c2.id, 'msg', `สายที่ไม่ได้รับ ${count} สาย`);
 if (ppViewing(c2.id)) renderThread(); else if (ppCurrentScreen === 'messages') renderContactList();
 islandNotify(c2, `สายที่ไม่ได้รับ ${count} สาย`);
 }
 // ── ข้อความย้อนหลัง: [PP_PASTMSG:ชื่อ|เวลาที่ผ่านมา|ข้อความ] จำลองว่าเคยส่งมาแล้ว ──
 const rxPast = /\[PP_PASTMSG:\s*([^\]]+?)\]/gi;
 while ((m = rxPast.exec(mes))) {
 const parts = String(m[1]).split('|');
 const nm = (parts[0] || '').trim();
 const ago = (parts[1] || '').trim();
 const body = parts.slice(2).join('|').trim();
 if (!nm || !body) continue;
 let c2 = getContacts().find(x => dname(x) === nm) || getContacts().find(x => nm.includes(dname(x)));
 if (!c2) {
 const cfg2 = getCfg();
 const st = listStCharacters().find(x => x.name === nm);
 c2 = st ? { id: st.id, name: st.name, avatar: st.avatar } : { id: 'npc:' + newId(), name: nm, avatar: '', npc: true, ownerCharId: currentCharacterId() || '' };
 cfg2.contacts.push(c2);
 saveCfg();
 }
 let baseTs = Date.now();
 const hourM = ago.match(/(\d+)\s*(ชม|ชั่วโมง|hour)/i);
 const dayM = ago.match(/(\d+)\s*(วัน|day)/i);
 if (/เมื่อคืน|last night|คืน/i.test(ago)) baseTs -= 9 * 3600000;
 else if (hourM) baseTs -= (parseInt(hourM[1], 10) || 1) * 3600000;
 else if (dayM) baseTs -= (parseInt(dayM[1], 10) || 1) * 86400000;
 else baseTs -= 3600000;
 const rawChunks = String(body).split(/\s*(?:\|\||\n)\s*/).map(s => s.trim()).filter(Boolean);
 const src = rawChunks.length ? rawChunks : [String(body).trim()];
 let unreadCount = 0, firstThemTxt = '';
 src.forEach((chunk, i) => {
 const fromMe = /^me\s*:/i.test(chunk); // ประโยคที่ผู้ใช้เคยพิมพ์
 const txt = stripEmoji(chunk.replace(/^me\s*:/i, '').trim());
 if (!txt) return;
 pushThreadMsg(c2.id, { from: fromMe ? 'me' : 'them', text: txt, ts: baseTs + i * 60000 });
 if (!fromMe) { unreadCount++; if (!firstThemTxt) firstThemTxt = txt; }
 });
 // เรียงข้อความในเธรดตามเวลาใหม่ (กันฟองย้อนหลังไปโผล่ล่างสุด)
 const th = getThread(c2.id);
 th.sort((a, b) => (a.ts || 0) - (b.ts || 0));
 saveCfg();
 if (unreadCount) bumpUnread(c2.id, unreadCount);
 if (firstThemTxt) pushNotif(c2.id, 'msg', firstThemTxt);
 if (ppViewing(c2.id)) renderThread(); else if (ppCurrentScreen === 'messages') renderContactList();
 if (firstThemTxt) islandNotify(c2, firstThemTxt);
 }
 // ── A: สายที่คุยจริงย้อนหลัง [PP_PASTCALL:ชื่อ|เมื่อไหร่|นาที|บท1||me:บท2] ──
 const rxPastCall = /\[PP_PASTCALL:\s*([^\]]+?)\]/gi;
 while ((m = rxPastCall.exec(mes))) {
 const parts = String(m[1]).split('|');
 const nm = (parts[0] || '').trim();
 if (!nm) continue;
 const ago = (parts[1] || '').trim();
 const mins = Math.max(1, Math.min(180, parseInt(parts[2], 10) || 1));
 const body = parts.slice(3).join('|').trim();
 let c2 = getContacts().find(x => dname(x) === nm) || getContacts().find(x => nm.includes(dname(x)));
 if (!c2) {
 const cfg2 = getCfg();
 const st = listStCharacters().find(x => x.name === nm);
 c2 = st ? { id: st.id, name: st.name, avatar: st.avatar } : { id: 'npc:' + newId(), name: nm, avatar: '', npc: true, ownerCharId: currentCharacterId() || '' };
 cfg2.contacts.push(c2);
 saveCfg();
 }
 const ts = ppAgoToTs(ago);
 const transcript = body
 ? String(body).split(/\s*(?:\|\||\n)\s*/).map(s => s.trim()).filter(Boolean).map(s => {
 const fromMe = /^me\s*:/i.test(s);
 return { from: fromMe ? 'me' : 'them', text: stripEmoji(s.replace(/^me\s*:/i, '').trim()) };
 }).filter(x => x.text)
 : [];
 const cfg = getCfg();
 if (!cfg.callLog) cfg.callLog = [];
 cfg.callLog.push({
 cid: c2.id, name: dname(c2), avatar: c2.avatar, chatId: ppStChatId(),
 startISO: new Date(ts).toISOString(), durText: fmtDur(mins * 60), incoming: true, transcript,
 });
 pushThreadMsg(c2.id, { from: 'them', type: 'call', dir: 'in', missed: false, text: `คุยกัน ${fmtDur(mins * 60)}`, ts });
 const thc = getThread(c2.id); thc.sort((a, b) => (a.ts || 0) - (b.ts || 0));
 saveCfg();
 bumpUnread(c2.id, 1);
 pushNotif(c2.id, 'msg', `สายที่คุยกัน ${fmtDur(mins * 60)}`);
 if (ppViewing(c2.id)) renderThread(); else if (ppCurrentScreen === 'messages') renderContactList();
 islandNotify(c2, `เคยคุยสายกัน ${fmtDur(mins * 60)}`);
 }
 // ── D: โอนเงินย้อนหลัง [PP_PASTPAY:ชื่อ|เมื่อไหร่|จำนวน|out หรือ in|เหตุผล] ──
 // out = ผู้ใช้เคยโอนให้ NPC · in = NPC เคยโอนให้ผู้ใช้
 const rxPastPay = /\[PP_PASTPAY:\s*([^\]]+?)\]/gi;
 while ((m = rxPastPay.exec(mes))) {
 const parts = String(m[1]).split('|');
 const nm = (parts[0] || '').trim();
 const ago = (parts[1] || '').trim();
 const amt = Math.abs(parseInt(parts[2], 10) || 0);
 const dir = /(^|[^a-z])in([^a-z]|$)/i.test(parts[3] || '') ? 'in' : 'out';
 const reason = (parts[4] || '').trim();
 if (!nm || !amt) continue;
 let c2 = getContacts().find(x => dname(x) === nm) || getContacts().find(x => nm.includes(dname(x)));
 if (!c2) {
 const cfg2 = getCfg();
 const st = listStCharacters().find(x => x.name === nm);
 c2 = st ? { id: st.id, name: st.name, avatar: st.avatar } : { id: 'npc:' + newId(), name: nm, avatar: '', npc: true, ownerCharId: currentCharacterId() || '' };
 cfg2.contacts.push(c2);
 saveCfg();
 }
 const ts = ppAgoToTs(ago);
 const cfg = getCfg();
 if (!cfg.walletHistory) cfg.walletHistory = [];
 if (dir === 'in') {
 adjustUserBalance(amt);
 cfg.walletHistory.push({ id: newId(), dir: 'in', amount: amt, cid: c2.id, name: dname(c2), note: reason || 'ย้อนหลัง', ts });
 pushThreadMsg(c2.id, { from: 'them', type: 'transfer', amount: amt, note: reason, status: 'accepted', ts });
 } else {
 adjustUserBalance(-amt);
 setBotWallet(c2.id, getBotWallet(c2.id) + amt);
 cfg.walletHistory.push({ id: newId(), dir: 'out', amount: amt, cid: c2.id, name: dname(c2), note: reason || 'ย้อนหลัง', ts });
 pushThreadMsg(c2.id, { from: 'me', type: 'transfer', amount: amt, note: reason, status: 'accepted', ts });
 }
 if (cfg.walletHistory.length > 200) cfg.walletHistory = cfg.walletHistory.slice(-200);
 const thp = getThread(c2.id); thp.sort((a, b) => (a.ts || 0) - (b.ts || 0));
 saveCfg();
 bumpUnread(c2.id, 1);
 pushNotif(c2.id, 'wallet', `${dir === 'in' ? 'ได้รับโอน' : 'โอนออก'} ${fmtMoney(amt)}`);
 if (ppViewing(c2.id)) renderThread(); else if (ppCurrentScreen === 'messages') renderContactList();
 updateHomeWidgets();
 islandNotify(c2, `${dir === 'in' ? 'เคยได้รับ' : 'เคยโอน'} ${fmtMoney(amt)}`);
 }
 const rxPay = /\[PP_PAY:\s*([^\]|]+)\|\s*(\d+)\s*(?:\|\s*([^\]]*))?\]/gi;
 while ((m = rxPay.exec(mes))) {
 const nm = m[1].trim(), amt = Math.abs(parseInt(m[2], 10) || 0), note = (m[3] || '').trim();
 if (!amt) continue;
 const c2 = getContacts().find(x => dname(x) === nm) || getContacts().find(x => nm.includes(dname(x)));
 if (c2) {
 pushThreadMsg(c2.id, { from: 'them', type: 'transfer', amount: amt, note: note || 'โอนจากในเรื่อง', status: 'pending' });
 bumpUnread(c2.id, 1);
 pushNotif(c2.id, 'wallet', `โอนเงิน ${fmtMoney(amt)}`);
 if (ppViewing(c2.id)) renderThread(); else if (ppCurrentScreen === 'messages') renderContactList();
 islandNotify(c2, `โอนเงินให้คุณ ${fmtMoney(amt)}`);
 } else {
 adjustUserBalance(amt);
 pushWalletHistory('in', amt, null, nm, note || 'จากในเรื่อง');
 }
 }
 const rxEarn = /\[PP_EARN:\s*(\d+)\s*(?:\|\s*([^\]]*))?\]/gi;
 while ((m = rxEarn.exec(mes))) {
 const amt = Math.abs(parseInt(m[1], 10) || 0), note = (m[2] || '').trim();
 if (amt) {
 adjustUserBalance(amt);
 pushWalletHistory('in', amt, null, 'รายได้', note || 'จากในเรื่อง');
 if (ppCurrentScreen === 'wallet') renderWallet();
 updateHomeWidgets();
 }
 }
 const rxFollow = /\[PP_FOLLOW:\s*([^\]]+)\]/gi;
 while ((m = rxFollow.exec(mes))) {
 const nm = m[1].trim();
 const c2 = getContacts().find(x => dname(x) === nm) || getContacts().find(x => nm.includes(dname(x)));
 if (!c2) continue;
 const cfg = getCfg();
 if (cfg.accountLocked) {
 if (!cfg.followRequests.includes(c2.id) && !isFollower(c2.id)) { cfg.followRequests.push(c2.id); pushNotif(c2.id, 'follow', `${dname(c2)} ขอติดตามคุณ`); }
 } else if (!cfg.followers.includes(c2.id)) {
 cfg.followers.push(c2.id);
 pushNotif(c2.id, 'follow', `${dname(c2)} เริ่มติดตามคุณ`);
 }
 saveCfg();
 }
 // ── บอทหลักหยิบมือถือตอบแทนผู้ใช้ [PP_REPLY:ชื่อ|ข้อความ] (ขึ้นฝั่งผู้ใช้) เปิดจากตั้งค่าเท่านั้น ──
 if (getCfg().allowBotReplyOnPhone) {
 const rxReply = /\[PP_REPLY:\s*([^\]]+?)\]/gi;
 while ((m = rxReply.exec(mes))) {
 const raw = m[1].trim();
 let nm = '', rest = '';
 if (raw.includes('|')) {
 const pipe = raw.indexOf('|');
 nm = raw.slice(0, pipe).trim();
 rest = raw.slice(pipe + 1).trim();
 } else {
 const sp = raw.indexOf(' ');
 if (sp > 0) { nm = raw.slice(0, sp).trim(); rest = raw.slice(sp + 1).trim(); }
 else { nm = raw; rest = ''; }
 }
 let c2 = getContacts().find(x => dname(x) === nm) || getContacts().find(x => nm && nm.includes(dname(x))) || getContacts().find(x => nm && dname(x).includes(nm));
 if (!c2 && nm && rest) {
 const cfg2 = getCfg();
 const st = listStCharacters().find(x => x.name === nm);
 c2 = st ? { id: st.id, name: st.name, avatar: st.avatar } : { id: 'npc:' + newId(), name: nm, avatar: '', npc: true, ownerCharId: currentCharacterId() || '' };
 cfg2.contacts.push(c2);
 saveCfg();
 }
 if (!c2 || !rest) continue;
 const chunks = String(rest).split(/\s*(?:\|\||\n)\s*/).map(s => stripEmoji(s.trim())).filter(Boolean);
 const lines = chunks.length ? chunks : [stripEmoji(rest)];
 lines.forEach(txt => { if (txt) pushThreadMsg(c2.id, { from: 'me', text: txt }); });
 saveCfg();
 if (ppViewing(c2.id)) renderThread(); else if (ppCurrentScreen === 'messages') renderContactList();
 }
 }
 // ห่อคีย์ในไฟล์ → ซ่อนบนจอ แต่คงข้อความให้บอทย้อนอ่าน/กดแก้ไขเห็น (ST re-render จากไฟล์นี้ จึงซ่อนถาวร)
 try {
 const wrapped = ppWrapKeys(mes);
 if (wrapped !== last.mes) {
 last.mes = wrapped;
 const idx = c.chat.length - 1;
 const dom = document.querySelector(`#chat .mes[mesid="${idx}"] .mes_text`);
 ppDetect();
 if (dom && PP_CAP.msgFormat) dom.innerHTML = c.messageFormatting(last.mes, last.name, false, false, idx);
 await ppSaveChatNow();
 }
 } catch (e) { console.warn('[pocket-phone] wrap keys', e); }
 // เก่ากว่า N เทิร์น → ลบสแปน+คีย์ออกจากไฟล์ กันโทเคนพอก
 ppSweepOldKeys();
 updateHomeWidgets();
 } catch (e) { console.warn('[pocket-phone] main-chat parse', e); }
}
// ══════════════════════════════════════════════════════════
// ★ 1.4.4 FRAME GUARD — กันประมวลผล frame เนื้อเดียวกันซ้ำ
// เรียกจากที่ไหนก็ตาม (event / observer / interval) ก็ผ่านได้แค่ครั้งเดียว
// ══════════════════════════════════════════════════════════
const ppFrameSeen = new Map(); // fingerprint -> timestamp
function ppSyncFrameFingerprint(payload, rawBody) {
 try {
  const list = payload && Array.isArray(payload.events) ? payload.events : [];
  if (list.length) {
   const sig = list.map(ev => {
    const t = String((ev && (ev.type || ev.kind)) || '?').toLowerCase();
    const who = String((ev && (ev.from || ev.author || ev.sender || ev.name || ev.group)) || '').toLowerCase().trim();
    const body = JSON.stringify((ev && (ev.text || ev.messages || ev.amount || ev.label || ev.place || ev.transcript)) || '').slice(0, 200).toLowerCase();
    return `${t}~${who}~${body}`;
   }).join('||');
   return 'F' + ppStableHash(sig);
  }
 } catch {}
 return 'R' + ppStableHash(String(rawBody || '').slice(0, 900));
}
/** true = เคยทำแล้ว ให้ข้าม · false = ยังไม่เคย และจดไว้ให้แล้ว */
function ppFrameAlreadyDone(fp) {
 const now = Date.now();
 for (const [k, ts] of ppFrameSeen) if (now - ts > 180000) ppFrameSeen.delete(k);
 if (ppFrameSeen.has(fp)) return true;
 ppFrameSeen.set(fp, now);
 if (ppFrameSeen.size > 80) {
  const oldest = [...ppFrameSeen.entries()].sort((a, b) => a[1] - b[1])[0];
  if (oldest) ppFrameSeen.delete(oldest[0]);
 }
 return false;
}
let ppMainSyncBusy = false; // ล็อคแบบ synchronous กันสองตัวเข้าพร้อมกัน
let ppMainSyncRunning = false;
let ppSyncWatchTimer = null;
let ppSyncObserver = null;
let ppSyncDebounce = null;
function ppMaskSyncFramesInDom(scope) {
 try {
  const root = scope && scope.querySelectorAll ? scope : document;
  const blocks = [];
  if (root.matches && root.matches('.mes_text')) blocks.push(root);
  root.querySelectorAll?.('.mes_text').forEach(el => blocks.push(el));
  blocks.forEach(el => {
   for (let guard = 0; guard < 4; guard++) {
    const flat = String(el.textContent || '');
    const start = flat.indexOf(PP_SYNC_FRAME_START);
    if (start < 0) break;
    const closeAt = flat.indexOf(PP_SYNC_FRAME_END, start + PP_SYNC_FRAME_START.length);
    const end = closeAt < 0 ? flat.length : closeAt + PP_SYNC_FRAME_END.length;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
    const nodes = []; let pos = 0, node;
    while ((node = walker.nextNode())) {
     const len = node.nodeValue.length;
     nodes.push({ node, from: pos, to: pos + len }); pos += len;
    }
    const a = nodes.find(x => start >= x.from && start <= x.to);
    const b = nodes.find(x => end >= x.from && end <= x.to) || nodes[nodes.length - 1];
    if (!a || !b) break;
    const range = document.createRange();
    range.setStart(a.node, Math.max(0, start - a.from));
    range.setEnd(b.node, Math.max(0, Math.min(b.node.nodeValue.length, end - b.from)));
    range.deleteContents(); el.dataset.ppSyncMasked = '1';
   }
  });
 } catch (e) { console.warn('[pocket-phone] sync DOM mask', e); }
}
function ppScheduleMainSync(delay) {
 clearTimeout(ppSyncDebounce);
 ppSyncDebounce = setTimeout(() => {
  ppMaskSyncFramesInDom(document);
  if (ppMainSyncBusy || ppMainSyncRunning) return;
  ppHandleMainChatMessage();
 }, Math.max(0, delay || 0));
}
function ppStartSyncWatchdog() {
 if (ppSyncWatchTimer) return;
 const scan = () => {
  ppMaskSyncFramesInDom(document);
  if (ppMainSyncBusy || ppMainSyncRunning) return;
  try {
   const c = ctx();
   const last = c && Array.isArray(c.chat) ? c.chat[c.chat.length - 1] : null;
   const mes = String(last && last.mes || '');
   // ★ 1.4.4 แตะเฉพาะตอนมี frame ค้างจริง หรือรอ frame ที่ยังไม่มา และ ST ว่างแล้ว
   if (mes.includes(PP_SYNC_FRAME_START)) ppHandleMainChatMessage();
   else if (ppBridgeExpected && !ppStGenBusy && !ppOwnGenBusy && ppGenAvailable()) ppHandleMainChatMessage();
  } catch {}
 };
 // ★ 1.4.4 จาก 900ms เป็น 2500ms — ลดโอกาสซ้อนกับ event
 ppSyncWatchTimer = setInterval(scan, 2500);
 const target = document.getElementById('chat') || document.body;
 if (target && typeof MutationObserver === 'function') {
  ppSyncObserver = new MutationObserver(mutations => {
   let sawFrame = false;
   mutations.forEach(m => {
    if (m.addedNodes) m.addedNodes.forEach(n => {
     if (n && n.nodeType === 1) {
      ppMaskSyncFramesInDom(n);
      if (String(n.textContent || '').includes(PP_SYNC_FRAME_START)) sawFrame = true;
     }
    });
   });
   // ★ 1.4.4 observer เรียกเฉพาะเมื่อเห็น frame โผล่จริง ไม่เรียกทุก mutation
   if (sawFrame) ppScheduleMainSync(400);
  });
  ppSyncObserver.observe(target, { childList: true, subtree: true, characterData: true });
 }
 scan();
}
async function ppHandleMainChatMessage() {
 // ★ 1.4.4 ล็อคทันทีแบบไม่รอ await — กันตัวที่สองเข้ามาระหว่างตัวแรกยังไม่จบ
 if (ppMainSyncBusy || ppMainSyncRunning) return;
 ppMainSyncBusy = true;
 try {
  const cfg = getCfg();
  if (cfg.autoSyncEnabled === false) { ppBridgeExpected = false; ppCancelActionBatch(); return; }
  const c = ctx();
  if (!c || !Array.isArray(c.chat) || !c.chat.length) return;
  const idx = c.chat.length - 1;
  const last = c.chat[idx];
  if (!last || last.is_user || last.is_system) return;

  const original = String(last.mes || '');
  const syncInfo = ppExtractSyncBatch(original);
  if (!syncInfo.found && (ppStGenBusy || ppOwnGenBusy)) return;
  if (syncInfo.found && syncInfo.error === 'unterminated Pocket Phone frame') return;

  // ★ ด่านหลัก: ลายนิ้วมือจากเนื้อ frame — ทำงานได้ก่อนแตะข้อมูลใด ๆ
  if (syncInfo.found) {
   const fp = ppSyncFrameFingerprint(syncInfo.payload, original.slice(syncInfo.start, syncInfo.end));
   if (ppFrameAlreadyDone(fp)) {
    // เคยประมวลผลแล้ว เหลือแค่เก็บกวาด frame ออกจากข้อความให้เรียบร้อย
    const cleanedOnly = ppFinalizeSyncMarker(original, syncInfo);
    if (cleanedOnly !== original) {
     last.mes = cleanedOnly;
     const dom0 = document.querySelector(`#chat .mes[mesid="${idx}"] .mes_text`);
     ppDetect();
     if (dom0 && PP_CAP.msgFormat) dom0.innerHTML = c.messageFormatting(last.mes, last.name, false, false, idx);
     await ppSaveChatNow();
    }
    ppBridgeExpected = false;
    ppCommitActionBatch();
    return;
   }
  }

  const cleaned = syncInfo.found ? ppFinalizeSyncMarker(original, syncInfo) : ppFinalizeSyncMarker(original, null);
  if (!syncInfo.found && !ppBridgeExpected) return;
  const key = ppMainSyncKey(last, idx, cleaned);
  if (ppWasMainSyncHandled(key)) {
   if (cleaned !== original) {
    last.mes = cleaned;
    const dom = document.querySelector(`#chat .mes[mesid="${idx}"] .mes_text`);
    ppDetect();
    if (dom && PP_CAP.msgFormat) dom.innerHTML = c.messageFormatting(last.mes, last.name, false, false, idx);
    await ppSaveChatNow();
   }
   ppBridgeExpected = false;
   ppCommitActionBatch();
   return;
  }

  ppMainSyncRunning = true;
  if (syncInfo.found) {
   if (syncInfo.error) { ppRecordSyncReceipt('invalid', 0, 0, syncInfo.error); ppPushSyncEvent(false, 'frame', '', syncInfo.error); }
   else {
    const result = ppApplySyncBatch(syncInfo.payload);
    const salv = syncInfo.salvaged ? ` (กู้ซาก ${syncInfo.salvaged})` : '';
    if (!result.valid) ppRecordSyncReceipt('invalid', 0, result.ignored, result.detail + salv);
    else if (result.applied > 0) ppRecordSyncReceipt('applied', result.applied, result.ignored, result.detail + salv);
    else ppRecordSyncReceipt('noop', 0, result.ignored, result.detail + salv);
   }
  } else {
   ppRecordSyncReceipt('missing', 0, 0, 'บอทไม่ได้แนบ frame มา');
   ppPushSyncEvent(false, 'frame', '', 'ไม่พบ frame ในคำตอบ');
  }
  ppRememberMainSync(key);
  ppCommitActionBatch();

  ppBridgeExpected = false;
  if (cleaned !== original) {
   last.mes = cleaned;
   const dom = document.querySelector(`#chat .mes[mesid="${idx}"] .mes_text`);
   ppDetect();
   if (dom && PP_CAP.msgFormat) dom.innerHTML = c.messageFormatting(last.mes, last.name, false, false, idx);
   await ppSaveChatNow();
  }
  ppRefreshAllViews();
  ppMaskSyncFramesInDom(document);
 } catch (e) { console.warn('[pocket-phone] main-chat v2 parse', e); }
 finally { ppMainSyncRunning = false; ppMainSyncBusy = false; }
}

// ══════════════════════════════════════════════════════════
// FAB — clamp ไม่หลุดจอ + drag
// ══════════════════════════════════════════════════════════
function applyFab() {
 const fab = document.getElementById('pp-fab');
 if (fab) fab.style.display = getCfg().showFab !== false ? 'flex' : 'none';
}
function fabClamp() {
 const fab = document.getElementById('pp-fab');
 if (!fab) return;
 const cfg = getCfg();
 const w = fab.offsetWidth || 54, h = fab.offsetHeight || 54;
 const vw = window.innerWidth, vh = window.innerHeight;
 const pad = 8;
 let x, y;
 if (cfg.fabPos && typeof cfg.fabPos.xPct === 'number') {
 x = cfg.fabPos.xPct * vw;
 y = cfg.fabPos.yPct * vh;
 } else {
 x = vw - w - 14;
 y = vh - h - 96;
 }
 x = Math.max(pad, Math.min(vw - w - pad, x));
 y = Math.max(pad, Math.min(vh - h - pad, y));
 fab.style.left = x + 'px';
 fab.style.top = y + 'px';
 fab.style.right = 'auto';
 fab.style.bottom = 'auto';
}
function saveFabPos() {
 const fab = document.getElementById('pp-fab');
 if (!fab) return;
 const cfg = getCfg();
 cfg.fabPos = {
 xPct: parseFloat(fab.style.left) / window.innerWidth,
 yPct: parseFloat(fab.style.top) / window.innerHeight,
 };
 saveCfg();
}
function injectFab() {
 if (document.getElementById('pp-fab')) return;
 const fab = document.createElement('button');
 fab.id = 'pp-fab';
 fab.title = 'Pocket Phone';
 fab.innerHTML = ICON.messages + `<span class="pp-logbadge"></span>`;
 document.body.appendChild(fab);
 fabClamp();
 applyFab();
 ppUpdateLogBadge();

 let dragging = false, moved = false, sx = 0, sy = 0, ox = 0, oy = 0;
 const down = (x, y) => {
 dragging = true; moved = false;
 sx = x; sy = y;
 ox = parseFloat(fab.style.left) || 0;
 oy = parseFloat(fab.style.top) || 0;
 };
 const move = (x, y) => {
 if (!dragging) return;
 const dx = x - sx, dy = y - sy;
 if (!moved && (Math.abs(dx) > 6 || Math.abs(dy) > 6)) { moved = true; fab.classList.add('pp-dragging'); }
 if (!moved) return;
 const w = fab.offsetWidth, h = fab.offsetHeight, pad = 8;
 fab.style.left = Math.max(pad, Math.min(window.innerWidth - w - pad, ox + dx)) + 'px';
 fab.style.top = Math.max(pad, Math.min(window.innerHeight - h - pad, oy + dy)) + 'px';
 };
 const up = () => {
 if (!dragging) return;
 dragging = false;
 fab.classList.remove('pp-dragging');
 if (moved) { saveFabPos(); setTimeout(() => { moved = false; }, 60); }
 };
 fab.addEventListener('mousedown', e => { e.preventDefault(); down(e.clientX, e.clientY); });
 document.addEventListener('mousemove', e => move(e.clientX, e.clientY));
 document.addEventListener('mouseup', up);
 fab.addEventListener('touchstart', e => down(e.touches[0].clientX, e.touches[0].clientY), { passive: true });
 document.addEventListener('touchmove', e => { if (dragging && moved) e.preventDefault(); if (dragging) move(e.touches[0].clientX, e.touches[0].clientY); }, { passive: false });
 document.addEventListener('touchend', up);
 fab.addEventListener('click', e => { if (moved) { e.stopPropagation(); return; } ppOpen(); });
 window.addEventListener('resize', fabClamp);
 window.addEventListener('orientationchange', () => setTimeout(fabClamp, 250));
}
function injectExternalIsland() {
 if (document.getElementById('pp-ext-island')) return;
 const el = document.createElement('div');
 el.id = 'pp-ext-island';
 el.addEventListener('click', () => {
 const cid = el.dataset.cid;
 ppOpen();
 if (cid) { const c = findContact(cid); if (c) { ppActiveContact = c; ppActiveGroup = null; ppNav('chat'); } }
 });
 document.body.appendChild(el);
}
function injectWandButton() {
 if (document.getElementById('pp-wand-btn')) return false;
 const menu = document.getElementById('extensionsMenu');
 if (!menu) return false;
 const item = document.createElement('div');
 item.id = 'pp-wand-btn';
 item.className = 'list-group-item flex-container flexGap5 interactable';
 item.tabIndex = 0;
 item.innerHTML = `<div style="width:20px;display:flex;justify-content:center">${ICON.messages}</div><span>Pocket Phone</span>`;
 item.querySelector('svg')?.setAttribute('width', '18');
 item.querySelector('svg')?.setAttribute('height', '18');
 item.addEventListener('click', () => ppOpen());
 menu.appendChild(item);
 return true;
}
function registerSettingsPanel() {
 const host = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
 if (!host || document.getElementById('pp-ext-drawer')) return;
 host.insertAdjacentHTML('beforeend', `
<div id="pp-ext-drawer" class="inline-drawer">
 <div class="inline-drawer-toggle inline-drawer-header">
 <b>Pocket Phone</b>
 <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
 </div>
 <div class="inline-drawer-content">
 <div style="font-size:12px;opacity:.7;margin-bottom:8px">version <b>${PP_VERSION}</b></div>
 <div style="font-size:12px;opacity:.7;margin-bottom:8px">เปิดจากปุ่มลอย หรือเมนู wand</div>
 <label style="display:flex;align-items:center;gap:8px;margin-bottom:6px"><input type="checkbox" id="pp-ext-fab-toggle"> แสดงปุ่มลอย</label>
 <label style="display:flex;align-items:center;gap:8px;margin-bottom:6px"><input type="checkbox" id="pp-ext-log-toggle"> แทรกกิจกรรมมือถือเข้าบทหลัก</label>
 <input id="pp-ext-open" class="menu_button" type="button" value="เปิดมือถือ">
 <input id="pp-ext-diag" class="menu_button" type="button" value="Diagnostics">
 <input id="pp-ext-strip" class="menu_button" type="button" value="ล้างข้อมูลซ่อนจากรุ่นเก่า">
 </div>
</div>`);
 const fabT = document.getElementById('pp-ext-fab-toggle');
 if (fabT) { fabT.checked = getCfg().showFab !== false; fabT.addEventListener('change', e => { getCfg().showFab = e.target.checked; saveCfg(); applyFab(); }); }
 const logT = document.getElementById('pp-ext-log-toggle');
 if (logT) { logT.checked = !!getCfg().logToStory; logT.addEventListener('change', e => { getCfg().logToStory = e.target.checked; saveCfg(); }); }
 document.getElementById('pp-ext-open')?.addEventListener('click', ppOpen);
 document.getElementById('pp-ext-diag')?.addEventListener('click', () => window.PP_DIAG());
 document.getElementById('pp-ext-strip')?.addEventListener('click', () => {
 if (confirm('ล้างบล็อก Pocket Phone ออกจากทุกข้อความในแชทนี้?')) ppStripAll().then(n => alert(`ล้างออกจาก ${n} ข้อความ — รีเฟรชหน้าเพื่อดูผล`));
 });
}

// ══════════════════════════════════════════════════════════
// EVENT DELEGATION
// ══════════════════════════════════════════════════════════
function injectPhone() {
 if (document.getElementById('pp-dialog')) return;
 const wrap = document.createElement('div');
 wrap.innerHTML = buildPhone();
 document.body.appendChild(wrap.firstElementChild);
 const dlg = document.getElementById('pp-dialog');
 dlg?.addEventListener('cancel', e => { e.preventDefault(); ppClose(); });
 const frame = document.getElementById('pp-frame');
 if (!frame) return;

 frame.addEventListener('click', e => {
 const t = e.target;
 const q = sel => t.closest(sel);

 // voice / poll ในฟอง — จับก่อน
 const voiceEl = q('[data-voiceidx]');
 if (voiceEl) return ppPlayVoice(+voiceEl.dataset.voiceidx);
 // ★ 1.4.1 แถบเทาที่ยกเลิกแล้ว → เปิดเมนูเต็ม (ส่อง / ส่งกลับ / แก้ไข / ลบถาวร)
 const peek = q('[data-peekmid]');
 if (peek) {
 const bub = peek.closest('[data-msgidx]');
 if (bub) return ppMsgActions(+bub.dataset.msgidx);
 return;
 }
 const voteEl = q('[data-vote]');
 if (voteEl) { e.stopPropagation(); const [i, oi] = voteEl.dataset.vote.split(':'); return ppVotePoll(+i, +oi); }
 const pvEl = q('[data-postvote]');
 if (pvEl) { e.stopPropagation(); const [pid, oi] = pvEl.dataset.postvote.split(':'); return ppVotePostPoll(pid, +oi); }
 const transAcc = q('[data-transacc]');
 if (transAcc) { e.stopPropagation(); return ppAcceptTransfer(+transAcc.dataset.transacc); }
 const transDec = q('[data-transdec]');
 if (transDec) { e.stopPropagation(); return ppDeclineTransfer(+transDec.dataset.transdec); }
 const sharedMenu = q('[data-sharedmenu]');
 if (sharedMenu) { e.stopPropagation(); return ppSharedCardMenu(+sharedMenu.dataset.sharedmenu); }
 const selMid = q('[data-selmid]');
 if (selMid) { e.stopPropagation(); return toggleSelect(selMid.dataset.selmid); }
 const warpEl = q('[data-warp]');
 if (warpEl) { e.stopPropagation(); return ppWarpTo(warpEl.dataset.warp); }
 const warpShare = q('[data-warpshare]');
 if (warpShare) { const [tid, mid] = warpShare.dataset.warpshare.split(':'); return ppWarpToShared(tid, mid); }

 // swipe row actions
 const sw = q('[data-sw]');
 if (sw) {
 e.stopPropagation();
 const tid = sw.dataset.tid;
 const a = sw.dataset.sw;
 if (a === 'pin') return ppTogglePin(tid);
 if (a === 'mute') return ppToggleMute(tid);
 if (a === 'arch') return ppToggleArchive(tid);
 if (a === 'del') return ppDeleteChat(tid);
 }

 // nav / open
 const navEl = q('[data-nav]');
 if (navEl) return ppNav(navEl.dataset.nav);
 const tidEl = q('[data-tid]');
 if (tidEl) return ppOpenThread(tidEl.dataset.tid);
 const unarch = q('[data-unarch]');
 if (unarch) return ppToggleArchive(unarch.dataset.unarch);
 if (t.closest('#pp-create-npc-row')) return ppCreateCustomNpc();
 const addEl = q('[data-add]');
 if (addEl) return ppAddContact(addEl.dataset.add);
 if (t.closest('#pp-close-btn')) return ppClose();

 // notes
 if (q('[data-usernote]')) {
 const cur = getUserNote();
 return ppPrompt('สเตตัสของคุณ (24 ชม.)', cur ? cur.text : '', v => { setUserNote(v); renderNotesRow(); ppToast(v ? 'ตั้งสเตตัสแล้ว' : 'ลบสเตตัสแล้ว'); });
 }
 const bn = q('[data-botnote]');
 if (bn) return ppOpenBotNote(bn.dataset.botnote);

 if (t.closest('#pp-scope-toggle')) { getCfg().ppShowAllContacts = !getCfg().ppShowAllContacts; saveCfg(); renderContactList(); return; }

 // tabs
 const ct = q('[data-chattab]');
 if (ct) { ppChatTab = ct.dataset.chattab; ppMsgFilter = ''; const s = document.getElementById('pp-msg-search'); if (s) s.value = ''; return renderContactList(); }
 const ft = q('[data-feedtab]');
 if (ft) { ppFeedTab = ft.dataset.feedtab; ppExploreTag = null; if (ppFeedTab === 'activity') { const cfg = getCfg(); cfg.notifCenter.forEach(n => n.seen = true); saveCfg(); updateHomeWidgets(); } return renderFeed(); }
 const pt = q('[data-proftab]');
 if (pt) { ppProfileTab = pt.dataset.proftab; return renderFeed(); }
 const wt = q('[data-wtab]');
 if (wt) { ppWalletTab = wt.dataset.wtab; return renderWallet(); }
 const ptab = q('[data-ptab]');
 if (ptab) { ppPeriodTab = ptab.dataset.ptab; return renderPeriod(); }
 const npk = q('[data-npkind]');
 if (npk) { ppNewPostDraft.kind = npk.dataset.npkind; return renderNewPost(); }

 // chat bar
 if (t.closest('#pp-attach-btn')) return ppAttachMenu();
 if (t.closest('#pp-sticker-btn')) { const tray = document.getElementById('pp-sticker-tray'); if (tray) { tray.classList.toggle('show'); if (tray.classList.contains('show')) renderStickerTray(); } return; }
 if (t.closest('#pp-gen')) return ppGenerateReply();
 if (t.closest('#pp-stop')) return ppStopGen();
 if (t.closest('#pp-regen-btn')) return ppRegenerate();
 if (t.closest('#pp-loadmore-btn')) { ppHistShown += HIST_PAGE; return renderThread(); }
 if (t.closest('#pp-chat-menu-btn')) return ppChatMenu();
 if (t.closest('#pp-chat-call-btn')) return ppStartCall();
 if (t.closest('#pp-msg-menu-btn')) return ppMsgListMenu();
 if (t.closest('#pp-star-banner')) return ppNav('starred');
 if (t.closest('#pp-group-new-btn')) { ppGroupDraft = null; return ppNav('groupnew'); }
 const spack = q('[data-spack]');
 if (spack) { ppStickerPackActive = spack.dataset.spack; return renderStickerTray(); }
 const stk = q('[data-sticker]');
 if (stk) { const [pid, i] = stk.dataset.sticker.split(':'); return ppSendSticker(pid, +i); }

 // bubble (ท้ายสุดของ chat)
 const bubble = q('[data-msgidx]');
 if (bubble) return ppMsgActions(+bubble.dataset.msgidx);

 // chat settings
 if (t.closest('#pp-rename-save') && ppActiveContact) {
 const v = (document.getElementById('pp-rename-input')?.value || '').trim();
 const stored = findContact(ppActiveContact.id);
 if (stored) { stored.customName = v || undefined; ppActiveContact.customName = v || undefined; saveCfg(); ppLogMinor('chat', `เปลี่ยนชื่อที่แสดงของคอนแทกต์เป็น "${v || stored.name}"`); renderChatSettings(); renderContactList(); ppToast('เปลี่ยนชื่อแล้ว'); }
 return;
 }
 if (t.closest('#pp-persona-save') && ppActiveContact) {
 const st = getChatStyle(ppActiveContact.id);
 st.personaName = (document.getElementById('pp-persona-name')?.value || '').trim();
 st.personaDesc = (document.getElementById('pp-persona-desc')?.value || '').trim();
 saveCfg(); ppToast('บันทึก Persona แล้ว');
 return;
 }
 if (t.closest('#pp-cs-ringtone-save') && ppActiveContact) {
 getChatStyle(ppActiveContact.id).ringtone = (document.getElementById('pp-cs-ringtone')?.value || '').trim();
 saveCfg(); ppToast('บันทึกเสียงเรียกเข้าแล้ว');
 return;
 }
 if (t.closest('#pp-bubble-clear') && ppActiveContact) {
 getChatStyle(ppActiveContact.id).bubbleImg = false; saveCfg(); applyChatStyle(); ppToast('ล้างรูปฟองแล้ว');
 return;
 }
 if (t.closest('#pp-calllog-btn') && ppActiveContact) { ppCallLogFilter = ppActiveContact.id; ppCallLogEdit = false; return ppNav('calllog'); }
 const cbg = q('[data-chatbg]');
 if (cbg) {
 const tid = curTid();
 if (!tid) return;
 if (cbg.dataset.chatbg === 'custom') return document.getElementById('pp-chatbg-file')?.click();
 getChatStyle(tid).bg = cbg.dataset.chatbg; saveCfg(); applyChatStyle();
 return ppCurrentScreen === 'groupsettings' ? renderGroupSettings() : renderChatSettings();
 }
 const upEl = q('[data-userpersona]');
 if (upEl && ppActiveContact) {
 getChatStyle(ppActiveContact.id).userPersonaId = upEl.dataset.userpersona;
 saveCfg(); renderChatSettings(); ppToast('ตั้ง persona แล้ว');
 return;
 }

 // group
 if (t.closest('#pp-group-save-btn')) return ppGroupSave();
 if (t.closest('#pp-group-members-btn')) {
 if (!ppGroupDraft) ppGroupDraft = { id: null, name: '', members: [], knowEachOther: true, cooldownSec: 0, replyMode: 'many', warnNote: '' };
 return ppMultiSelect({ title: 'เลือกสมาชิกกลุ่ม', selected: ppGroupDraft.members, onDone: arr => { ppGroupDraft.members = arr; renderGroupEditor(); } });
 }
 if (t.closest('#pp-group-del-btn')) return ppDeleteGroup();

 // feed
 const po = q('[data-postopen]');
 if (po) { ppActivePost = po.dataset.postopen; return ppNav('postview'); }
 const opEl = q('[data-openpost]');
 if (opEl) { ppActivePost = opEl.dataset.openpost; return ppNav('postview'); }
 const pl = q('[data-postlike]');
 if (pl) { e.stopPropagation(); return toggleFeedLike(pl.dataset.postlike); }
 const ps = q('[data-postsave]');
 if (ps) { e.stopPropagation(); return toggleSavePost(ps.dataset.postsave); }
 const pm2 = q('[data-postmenu]');
 if (pm2) { e.stopPropagation(); return ppPostMenu(pm2.dataset.postmenu); }
 const psh = q('[data-postshare]');
 if (psh) { e.stopPropagation(); return ppSharePostToChat(psh.dataset.postshare); }
 const prp = q('[data-postrepost]');
 if (prp) { e.stopPropagation(); return ppRepostMenu(prp.dataset.postrepost); }
 const mnt = q('[data-mention]');
 if (mnt) {
  e.stopPropagation();
  const r = resolveMention(mnt.dataset.mention);
  if (r && r.user) { ppFeedTab = 'profile'; return renderFeed(); }
  if (r && r.contact) { ppActiveContact = r.contact; ppActiveGroup = null; return ppNav('chat'); }
  return ppToast('ไม่พบบัญชีนี้');
 }
 const mno = q('[data-mentionopen]');
 if (mno) {
  const cfg2 = getCfg();
  (cfg2.mentionsInbox || []).forEach(x => { if (x.pid === mno.dataset.mentionopen) x.seen = true; });
  saveCfg();
  ppActivePost = mno.dataset.mentionopen;
  return ppNav('postview');
 }
 const nwo = q('[data-newsopen]');
 if (nwo) {
  const cfg3 = getCfg();
  if (!cfg3.newsSeen) cfg3.newsSeen = {};
  cfg3.newsSeen[nwo.dataset.newsopen] = true;
  saveCfg();
  ppActivePost = nwo.dataset.newsopen;
  return ppNav('postview');
 }
 if (t.closest('#pp-news-gen')) return ppNewsGenerate();
 if (t.closest('#pp-news-stop')) return ppStopFeedGen();
 const tag = q('[data-tag]');
 if (tag) { e.stopPropagation(); ppExploreTag = tag.dataset.tag; ppFeedTab = 'home'; return renderFeed(); }
 if (q('[data-tagclear]')) { ppExploreTag = null; return renderFeed(); }
 const cml = q('[data-cmtlike]');
 if (cml) { e.stopPropagation(); return toggleCommentLike(cml.dataset.cmtlike); }
 const cmr = q('[data-cmtreply]');
 if (cmr) { e.stopPropagation(); return ppReplyComment(cmr.dataset.cmtreply); }
 const cmd2 = q('[data-cmtdel]');
 if (cmd2) { e.stopPropagation(); return ppDeleteComment(cmd2.dataset.cmtdel); }
 const cmw = q('[data-cmtwarp]');
 if (cmw) { e.stopPropagation(); return ppCommentWarp(cmw.dataset.cmtwarp); }
 const cmm = q('[data-cmtmenu]');
 if (cmm) return ppCommentActions(cmm.dataset.cmtmenu);
 if (t.closest('#pp-feed-gen-btn')) return ppPickFeedAuthor();
 if (t.closest('#pp-feed-stop-btn')) return ppStopFeedGen();
 if (t.closest('#pp-post-gen-btn')) return ppPickCommenters();
 if (t.closest('#pp-post-stop-btn')) return ppStopFeedGen();
 if (t.closest('#pp-comment-send')) return ppSendComment();
 if (t.closest('#pp-feed-add')) { ppNewPostDraft = null; return ppNav('newpost'); }
 if (t.closest('#pp-feed-news')) { ppFeedTab = 'explore'; return renderFeed(); }
 if (t.closest('#pp-act-clear')) { const cfg = getCfg(); cfg.notifCenter = []; saveCfg(); renderFeed(); updateHomeWidgets(); return ppToast('ล้างกิจกรรมแล้ว'); }
 if (t.closest('#pp-prof-privacy')) return ppNav('account');
 const sa = q('[data-storyauthor]');
 if (sa) return ppStoryAuthorTap(sa.dataset.storyauthor);
 const hl = q('[data-hl]');
 if (hl) return openHighlight(hl.dataset.hl);
 const nd = q('[data-notifdel]');
 if (nd) { e.stopPropagation(); const cfg = getCfg(); cfg.notifCenter = (cfg.notifCenter || []).filter(x => x.id !== nd.dataset.notifdel); saveCfg(); renderFeed(); updateHomeWidgets(); return; }
 const notif = q('[data-notif]');
 if (notif) {
 const n = (getCfg().notifCenter || []).find(x => x.id === notif.dataset.notif);
 if (n) { n.seen = true; saveCfg(); updateHomeWidgets(); if (n.cid && findContact(n.cid)) { ppOpenThread(n.cid); } }
 return;
 }
 const fok = q('[data-followok]');
 if (fok) { e.stopPropagation(); return ppFollowRespond(fok.dataset.followok, true); }
 const fno = q('[data-followno]');
 if (fno) { e.stopPropagation(); return ppFollowRespond(fno.dataset.followno, false); }
 if (q('[data-followerlist]')) return ppAccountList('followers', 'ผู้ติดตาม', 'ผู้ติดตาม');
 if (q('[data-followinglist]')) return ppAccountList('following', 'กำลังติดตาม', 'กำลังติดตาม');

 // new post
 if (t.closest('#pp-newpost-save')) return ppNewPostSave();
 if (t.closest('#pp-np-capai')) return ppNewPostCaptionAI();
 if (t.closest('#pp-np-imgclear')) {
 const d = ppNewPostDraft;
 d.mediaKeys.forEach(k => delMedia(k));
 d.mediaKeys = []; d.previews = []; d.captions = [];
 return renderNewPost();
 }
 const rmimg = q('[data-rmimg]');
 if (rmimg) {
 const i = +rmimg.dataset.rmimg;
 const d = ppNewPostDraft;
 delMedia(d.mediaKeys[i]);
 d.mediaKeys.splice(i, 1); d.previews.splice(i, 1); d.captions.splice(i, 1);
 return renderNewPost();
 }
 const npbg = q('[data-npbg]');
 if (npbg) { ppNewPostDraft.bg = npbg.dataset.npbg; return renderNewPost(); }
 if (t.closest('#pp-np-poll')) {
 return ppPrompt('คำถามโพล (เว้นว่าง = เอาออก)', ppNewPostDraft.poll?.question || '', q1 => {
 if (!q1) { ppNewPostDraft.poll = null; return renderNewPost(); }
 ppPrompt('ตัวเลือก (บรรทัดละข้อ)', (ppNewPostDraft.poll?.options || []).map(o => o.text).join('\n'), raw => {
 const opts = String(raw || '').split('\n').map(s => s.trim()).filter(Boolean).slice(0, 6);
 if (opts.length < 2) { ppToast('ต้องมีอย่างน้อย 2 ตัวเลือก'); return; }
 ppNewPostDraft.poll = { question: q1, options: opts.map(x => ({ text: x, votes: [] })) };
 renderNewPost();
 }, { rows: 4 });
 }, { rows: 2 });
 }
 if (t.closest('#pp-np-question')) {
 return ppPrompt('คำถามในกล่อง (เว้นว่าง = เอาออก)', ppNewPostDraft.question || '', v => { ppNewPostDraft.question = v; renderNewPost(); }, { rows: 2 });
 }
 if (t.closest('#pp-np-allowed')) {
 return ppMultiSelect({ title: 'เลือกคนที่เห็นได้', selected: ppNewPostDraft.allowed, onDone: arr => { ppNewPostDraft.allowed = arr; renderNewPost(); } });
 }
 if (t.closest('#pp-np-responders')) {
 return ppMultiSelect({ title: 'จำกัดคนที่ตอบได้', selected: ppNewPostDraft.responders, onDone: arr => { ppNewPostDraft.responders = arr; renderNewPost(); } });
 }

 // profile / account
 if (t.closest('#pp-prof-save')) return ppProfileSave();
 if (t.closest('#pp-pe-note')) {
 const cur = getUserNote();
 return ppPrompt('สเตตัส 24 ชม.', cur ? cur.text : '', v => { setUserNote(v); renderProfileEdit(); });
 }
 if (t.closest('#pp-pe-hl')) {
 const hls = getCfg().storyHighlights || [];
 return ppSheet('Highlights', hls.length
 ? hls.map(h => ({ label: `${h.name} (${(h.storyIds || []).length})`, icon: ICON.star, onClick: () => openHighlight(h.id) }))
 .concat([{ label: 'ลบ Highlight', icon: ICON.trash, danger: true, onClick: () => ppSheet('ลบอันไหน', hls.map(h => ({ label: h.name, danger: true, onClick: () => { const cfg = getCfg(); cfg.storyHighlights = cfg.storyHighlights.filter(x => x.id !== h.id); saveCfg(); renderProfileEdit(); ppToast('ลบแล้ว'); } }))) }])
 : [{ label: 'ยังไม่มี Highlight — เปิดสตอรี่ของตัวเองเพื่อเก็บ', onClick: () => {} }]);
 }
 if (t.closest('#pp-acc-followers')) return ppAccountList('followers', 'ผู้ติดตาม', 'ผู้ติดตาม');
 if (t.closest('#pp-acc-following')) return ppAccountList('following', 'กำลังติดตาม', 'กำลังติดตาม');
 if (t.closest('#pp-acc-close')) return ppAccountList('closeFriends', 'เพื่อนสนิท', 'เพื่อนสนิท');
 if (t.closest('#pp-acc-restrict')) return ppAccountList('restricted', 'จำกัด', 'คนที่ถูกจำกัด');
 if (t.closest('#pp-acc-block')) return ppAccountList('blocked', 'บล็อก', 'คนที่ถูกบล็อก');

 // wallet
 if (t.closest('#pp-wallet-menu')) return ppWalletMenu();
 if (t.closest('#pp-w-send')) return ppPickContact('โอนให้ใคร', cid => ppTransferComposer(cid));
 if (t.closest('#pp-w-request')) return ppWalletRequest();
 if (t.closest('#pp-w-topup')) return ppWalletTopup();
 if (t.closest('#pp-w-deduct')) return ppWalletDeduct();
 const wsend = q('[data-wsend]');
 if (wsend) return ppTransferComposer(wsend.dataset.wsend);
 const wreq = q('[data-wreq]');
 if (wreq) return ppWalletRequest(wreq.dataset.wreq);
 if (t.closest('#pp-w-name')) return ppPrompt('ชื่อบัญชี (เว้นว่าง = ชื่อแอป)', getCfg().walletName || '', v => { getCfg().walletName = v; saveCfg(); renderWallet(); ppToast('บันทึกแล้ว'); }, { rows: 1 });
 if (t.closest('#pp-w-acc')) return ppPrompt('เลขบัญชี', getCfg().walletAccount || '', v => { if (v) { getCfg().walletAccount = v; saveCfg(); renderWallet(); } }, { rows: 1 });
 const wbe = q('[data-wbotedit]');
 if (wbe) {
 const cid = wbe.dataset.wbotedit;
 return ppPrompt(`ยอดเงินของ ${cname(cid)}`, String(getBotWallet(cid)), v => {
 const n = Math.abs(parseInt(String(v).replace(/[^\d]/g, ''), 10) || 0);
 setBotWallet(cid, n); renderWallet(); ppToast('บันทึกแล้ว');
 }, { rows: 1 });
 }
 if (t.closest('#pp-w-reset')) {
 return ppConfirm('ล้างประวัติธุรกรรม', 'ลบประวัติทั้งหมด? ยอดเงินคงเดิม', () => {
 const _wh = walletHistoryArr(); _wh.length = 0; saveCfg(); renderWallet(); ppToast('ล้างแล้ว');
 }, 'ล้าง');
 }

 // period
 const cal = q('[data-calday]');
 if (cal) return ppPeriodDayTap(cal.dataset.calday);
 if (t.closest('#pp-cal-prev')) return ppCalNav(-1);
 if (t.closest('#pp-cal-next')) return ppCalNav(1);
 if (t.closest('#pp-p-marktoday')) { togglePeriodDay(ymd(new Date())); renderPeriod(); return updateHomeWidgets(); }
 const pf = q('[data-pflow]');
 if (pf) { savePeriodLog(ymd(new Date()), { flow: pf.dataset.pflow }); return renderPeriod(); }
 const psy = q('[data-psym]');
 if (psy) {
 const today = ymd(new Date());
 const log = getPeriodLog(today);
 const s = psy.dataset.psym;
 const i = log.symptoms.indexOf(s);
 if (i >= 0) log.symptoms.splice(i, 1); else log.symptoms.push(s);
 savePeriodLog(today, { symptoms: log.symptoms });
 return renderPeriod();
 }
 const pmo = q('[data-pmood]');
 if (pmo) { savePeriodLog(ymd(new Date()), { mood: pmo.dataset.pmood }); return renderPeriod(); }
 if (t.closest('#pp-p-savenote')) {
 const v = (document.getElementById('pp-p-note')?.value || '').trim();
 savePeriodLog(ymd(new Date()), { note: v });
 return ppToast('บันทึกโน้ตแล้ว');
 }
 if (t.closest('#pp-p-who')) {
 const cfg = getCfg();
 return ppSheet('ให้ใครรู้เรื่องรอบเดือน', [
 { label: 'ทุกคน', icon: ICON.users, onClick: () => { cfg.periodSharedWith = null; saveCfg(); renderPeriod(); } },
 { label: 'เลือกรายคน', icon: ICON.person, onClick: () => ppMultiSelect({
 title: 'ให้ใครรู้', selected: cfg.periodSharedWith || [],
 onDone: arr => { cfg.periodSharedWith = arr; saveCfg(); ppLog('period', `ตั้งให้เฉพาะ ${arr.map(cname).join(', ') || 'ไม่มีใคร'} รู้เรื่องรอบเดือน`); renderPeriod(); }
 }) },
 ]);
 }
 if (t.closest('#pp-p-reset')) {
 return ppConfirm('ล้างข้อมูลรอบเดือน', 'ลบวันที่ทำเครื่องหมายและบันทึกอาการทั้งหมด?', () => {
 const cfg = getCfg();
 cfg.periods = []; cfg.periodLogs = {};
 saveCfg();
 ppLog('period', 'ล้างข้อมูลรอบเดือนทั้งหมด');
 renderPeriod(); updateHomeWidgets();
 ppToast('ล้างแล้ว');
 }, 'ล้าง');
 }
 if (t.closest('#pp-period-help')) {
 return ppAlert('ประจำเดือน', 'แตะวันในปฏิทินเพื่อทำเครื่องหมาย แตะซ้ำเพื่อบันทึกอาการ<br><br>สถานะรอบปัจจุบันถูกฉีดเข้า prompt ใหม่ทุกครั้งที่บอทตอบ ค่าจึงถูกต้องเสมอ<br><br>ปิดการแชร์ได้ที่แท็บความเป็นส่วนตัว และดูข้อความที่บอทเห็นจริงได้ที่นั่น');
 }

 // settings
 if (t.closest('#pp-set-logpreview')) return ppAlert('บล็อกที่จะแทรก', `<div class="pp-promptbox">${esc(ppPreviewLog())}</div>`);
 if (t.closest('#pp-set-logstrip')) {
 return ppConfirm('ล้างบล็อกออกจากแชท', 'ลบบล็อก Pocket Phone ออกจากทุกข้อความในแชทนี้?', () => {
 ppStripAll().then(n => ppAlert('เสร็จแล้ว', `ล้างออกจาก ${n} ข้อความ<br>รีเฟรชหน้าเพื่อดูผล`));
 }, 'ล้าง');
 }
 if (t.closest('#pp-set-cloutreset')) {
  return ppConfirm('ล้างชื่อเสียง', 'รีเซ็ตผู้ติดตามผีและประวัติกระแสทั้งหมด?', () => {
   const cfg4 = getCfg();
   cfg4.ghostFollowers = 0; cfg4.ghostFollowHistory = []; cfg4.ghostRegulars = []; cfg4.ghostViewerNames = [];
   saveCfg(); renderPhoneSettings(); ppToast('ล้างแล้ว');
  }, 'ล้าง');
 }
 if (t.closest('#pp-set-cloutseed')) {
  return ppPrompt('ตั้งยอดผู้ติดตามผีเริ่มต้น', String(ghostCount()), v2 => {
   const n = Math.max(0, parseInt(String(v2).replace(/[^\d]/g, ''), 10) || 0);
   const cfg5 = getCfg();
   cfg5.ghostFollowers = n; saveCfg();
   ppLog('account', `ปรับยอดผู้ติดตามเป็น ${totalFollowerCount()}`);
   renderPhoneSettings(); ppToast('ตั้งแล้ว');
  }, { rows: 1, hint: 'ใช้ตอนอยากเริ่มต้นแบบดังอยู่แล้ว' });
 }
 // ★ 1.4.0 โหมดรายชื่อคอนแทกต์
 const cmode = q('[data-cmode]');
 if (cmode) {
  getCfg().contactSendMode = cmode.dataset.cmode;
  saveCfg();
  renderPhoneSettings();
  return ppToast('บันทึกแล้ว · กด "วัดใหม่" เพื่อดูโทเคนที่เปลี่ยน');
 }
 // ★ 1.4.0 สติกเกอร์จากรูปในเครื่อง
 if (t.closest('#pp-stk-quickimg')) return ppPickStickerImages();
 if (t.closest('#pp-sticker-add-pack2')) {
  return ppPrompt('ชื่อชุดสติกเกอร์', '', name => {
   if (!name) return;
   getCfg().stickerPacks.push({ id: newId(), name: name.slice(0, 24), items: [] });
   saveCfg(); renderStickerManager(); ppToast('สร้างชุดแล้ว');
  }, { rows: 1 });
 }
 const spimg = q('[data-spimg]');
 if (spimg) return ppPickStickerImages(spimg.dataset.spimg);
 // ★ 1.4.1 แก้ชื่อป้ายสติกเกอร์รายรูป
 const silb = q('[data-silabel]');
 if (silb) {
  const [pid2, i2] = silb.dataset.silabel.split(':');
  const pk = findStickerPack(pid2);
  const it2 = pk && (pk.items || [])[+i2];
  if (!it2) return;
  return ppPrompt('ชื่อป้ายสติกเกอร์', it2.label || '', v => {
   it2.label = (v || '').trim().slice(0, 40);
   saveCfg(); renderStickerManager();
   ppToast(it2.label ? `ตั้งชื่อว่า "${it2.label}"` : 'เอาชื่อป้ายออกแล้ว');
  }, { rows: 1, hint: 'บอทเรียกสติกเกอร์จากชื่อนี้ · เว้นว่าง = บอทส่งรูปนี้ไม่ได้' });
 }
 // ★ 1.3.0 preset + วัดโทเคน + หน้าผลซิงค์
 const bpre = q('[data-bpreset]');
 if (bpre) {
  ppApplyBridgePreset(bpre.dataset.bpreset);
  renderPhoneSettings();
  const lb = { off: 'ปิดทั้งหมด', need: 'เปิดเท่าที่จำเป็น', all: 'เปิดทั้งหมด' }[bpre.dataset.bpreset];
  return ppToast(lb + ' แล้ว');
 }
 if (t.closest('#pp-tok-remeasure')) {
  ppToast('กำลังวัด…');
  return ppMeasureBridgeTokens(true).then(() => { if (ppCurrentScreen === 'settings') renderPhoneSettings(); ppToast('วัดใหม่แล้ว'); });
 }
 if (t.closest('#pp-sync-clear')) {
  return ppConfirm('ล้างรายการผลซิงค์', 'ลบประวัติผลซิงค์ทั้งหมด? ไม่กระทบข้อมูลในมือถือ', () => {
   const cfg2 = getCfg();
   cfg2.syncEventLog = []; cfg2.syncStats = { turns: 0, applied: 0, noop: 0, missing: 0, invalid: 0 }; cfg2.lastSyncReceipt = null;
   saveCfg(); renderSyncView(); ppToast('ล้างแล้ว');
  }, 'ล้าง');
 }
 // ★ 1.3.0 ปุ่มในหน้าสาย
 if (t.closest('#pp-call-min')) return ppMinimizeCall();
 if (t.closest('#pp-call-hist')) return ppToggleCallHistory();
 // ★ 1.4.3 ยุบรวม NPC ที่เป็นตัวละครหลักซ้ำ
 if (t.closest('#pp-set-fixnpc')) {
  const stChars = listStCharacters();
  const norm = s => String(s || '').toLowerCase().replace(/\s+/g, '');
  const cfg2 = getCfg();
  const dupes = [];
  cfg2.contacts.forEach(c2 => {
   if (!c2.npc) return;
   const hit = stChars.find(sc => norm(sc.name) === norm(c2.name)
    || (norm(sc.name).length >= 3 && norm(c2.name).includes(norm(sc.name)))
    || (norm(c2.name).length >= 3 && norm(sc.name).includes(norm(c2.name))));
   if (hit) dupes.push({ npc: c2, real: hit });
  });
  if (!dupes.length) return ppToast('ไม่พบตัวละครหลักที่ถูกสร้างซ้ำ');
  return ppConfirm('รวมกลับเป็นตัวละครหลัก',
   `พบ ${dupes.length} รายการ:\n${dupes.map(d => `${dname(d.npc)} → ${d.real.name}`).join('\n')}\n\nข้อความจะถูกย้ายไปรวมกับตัวละครหลัก`,
   () => {
    let moved = 0;
    dupes.forEach(d => {
     const srcKey = threadKey(d.npc.id);
     const dstId = d.real.id;
     let dst = cfg2.contacts.find(x => x.id === dstId);
     if (!dst) { dst = { id: dstId, name: d.real.name, avatar: d.real.avatar }; cfg2.contacts.push(dst); }
     const srcTh = cfg2.threads[srcKey] || cfg2.threads[d.npc.id] || [];
     if (srcTh.length) {
      const dstTh = getThread(dstId);
      Array.prototype.push.apply(dstTh, srcTh);
      dstTh.sort((a, b) => (a.ts || 0) - (b.ts || 0));
      moved += srcTh.length;
     }
     delete cfg2.threads[srcKey];
     delete cfg2.threads[d.npc.id];
     delete cfg2.starred[srcKey];
     delete cfg2.unread[srcKey];
     delete cfg2.drafts[srcKey];
     if (cfg2.botNotes) delete cfg2.botNotes[d.npc.id];
     cfg2.contacts = cfg2.contacts.filter(x => x.id !== d.npc.id);
     cfg2.pinned = cfg2.pinned.filter(x => x !== d.npc.id);
     cfg2.mutedChats = cfg2.mutedChats.filter(x => x !== d.npc.id);
     cfg2.archivedChats = cfg2.archivedChats.filter(x => x !== d.npc.id);
     (cfg2.callLog || []).forEach(l => { if (l.cid === d.npc.id) l.cid = dstId; });
     (cfg2.groups || []).forEach(g2 => { g2.members = (g2.members || []).map(x => x === d.npc.id ? dstId : x); });
    });
    saveCfg();
    ppRefreshAllViews();
    ppAlert('รวมเสร็จแล้ว', `ยุบรวม ${dupes.length} รายการ · ย้ายข้อความ ${moved} ข้อความ<br><br>เปิดหน้าข้อความดูได้เลย`);
   }, 'รวมเลย');
 }
 if (t.closest('#pp-set-diag')) { window.PP_DIAG(); return ppToast('ผลอยู่ใน console'); }
 if (t.closest('#pp-log-clear')) {
 return ppConfirm('ล้างคิว', 'ลบเหตุการณ์ที่ค้างคิวทั้งหมด? จะไม่ถูกส่งเข้าบทหลัก', () => {
 getCfg().actionLog = []; ppLogSelected.clear(); saveCfg(); ppUpdateLogBadge(); renderLogView(); ppToast('ล้างคิวแล้ว');
 }, 'ล้าง');
 }
 const logsel = q('[data-logsel]');
 if (logsel) {
 const id = logsel.dataset.logsel;
 if (ppLogSelected.has(id)) ppLogSelected.delete(id); else ppLogSelected.add(id);
 return renderLogView();
 }
 if (t.closest('#pp-log-clearsel')) { ppLogSelected.clear(); return renderLogView(); }
 if (t.closest('#pp-log-delsel')) {
 const n = ppLogSelected.size;
 return ppConfirm('ลบที่เลือก', `ลบ ${n} รายการที่เลือกออกจากคิว?`, () => {
 const cfg = getCfg();
 cfg.actionLog = (cfg.actionLog || []).filter(e => !ppLogSelected.has(e.id));
 ppLogSelected.clear();
 saveCfg(); ppUpdateLogBadge(); renderLogView(); ppToast('ลบแล้ว');
 }, 'ลบ');
 }
 const wp = q('[data-wp]');
 if (wp) {
 if (wp.dataset.wp === 'custom') return document.getElementById('pp-set-wp-file')?.click();
 getCfg().wallpaper = wp.dataset.wp; saveCfg(); applyWallpaper(); return renderPhoneSettings();
 }

 // sticker manager
 if (t.closest('#pp-sticker-import')) return ppStickerImportMenu();
 if (t.closest('#pp-sticker-add-pack')) {
 return ppPrompt('ชื่อชุดสติกเกอร์', '', name => {
 if (!name) return;
 getCfg().stickerPacks.push({ id: newId(), name: name.slice(0, 24), items: [] });
 saveCfg(); renderStickerManager(); ppToast('สร้างชุดแล้ว');
 }, { rows: 1 });
 }
 const spadd = q('[data-spadd]');
 if (spadd) {
 const pack = findStickerPack(spadd.dataset.spadd);
 if (!pack) return;
 return ppPrompt('ลิงก์รูปสติกเกอร์', '', url => {
 if (!url) return;
 ppPrompt('ชื่อป้าย (บอทใช้เรียก)', '', label => {
 pack.items = pack.items || [];
 pack.items.push({ url, label: label || '' });
 saveCfg(); renderStickerManager(); ppToast('เพิ่มแล้ว');
 }, { rows: 1, placeholder: 'เช่น ยิ้ม' });
 }, { rows: 2, placeholder: 'https://…' });
 }
 const spren = q('[data-sprename]');
 if (spren) {
 const pack = findStickerPack(spren.dataset.sprename);
 if (!pack) return;
 return ppPrompt('ชื่อชุด', pack.name, v => { if (v) { pack.name = v.slice(0, 24); saveCfg(); renderStickerManager(); } }, { rows: 1 });
 }
 const spdel = q('[data-spdel]');
 if (spdel) {
 const id = spdel.dataset.spdel;
 return ppConfirm('ลบชุดสติกเกอร์', 'ลบชุดนี้และสติกเกอร์ในชุด?', () => {
 const cfg = getCfg();
 cfg.stickerPacks = cfg.stickerPacks.filter(p => p.id !== id);
 saveCfg(); renderStickerManager(); ppToast('ลบแล้ว');
 }, 'ลบ');
 }
 const sidel = q('[data-sidel]');
 if (sidel) {
 const [pid, i] = sidel.dataset.sidel.split(':');
 const pack = findStickerPack(pid);
 if (pack) { pack.items.splice(+i, 1); saveCfg(); renderStickerManager(); }
 return;
 }

 // call
 if (t.closest('#pp-call-gen')) return ppCallGenerate(false);
 if (t.closest('#pp-call-end')) return ppEndCall();
 if (t.closest('#pp-call-accept')) return ppAcceptCall();
 if (t.closest('#pp-call-decline')) return ppDeclineCall();
 if (t.closest('#pp-callend-ok')) return ppNav((ppActiveGroup || ppActiveContact) ? 'chat' : 'messages');
 const cc = q('.pp-cc');
 if (cc) { cc.classList.toggle('on'); return; }
 if (t.closest('#pp-calllog-back')) { const had = ppCallLogFilter; ppCallLogFilter = null; return ppNav(had && ppActiveContact ? 'chat' : 'home'); }
 if (t.closest('#pp-calllog-edit-btn')) { ppCallLogEdit = !ppCallLogEdit; return renderCallLog(); }
 const dellog = q('[data-dellog]');
 if (dellog) { e.stopPropagation(); const cfg = getCfg(); cfg.callLog.splice(+dellog.dataset.dellog, 1); saveCfg(); return renderCallLog(); }
 const showtr = q('[data-showtr]');
 if (showtr) return showTranscript(+showtr.dataset.showtr);

 // island
 const island = q('#pp-island');
 if (island && island.dataset.cid) {
 // ★ 1.3.0 ถ้าสายยังต่ออยู่ แตะเพื่อกลับเข้าหน้าสาย
 if (island.dataset.calllive === '1' && ppCall) return ppResumeCall();
 const c2 = findContact(island.dataset.cid);
 if (c2) { ppActiveContact = c2; ppActiveGroup = null; return ppNav('chat'); }
 }
 });

 // double-tap like บนรูปโพสต์
 frame.addEventListener('click', e => {
 const img = e.target.closest('[data-dbl]');
 if (!img) return;
 const pid = img.dataset.dbl;
 const now = Date.now();
 if (img._lastTap && now - img._lastTap < 330) {
 const p = findPost(pid);
 if (p && !(p.likes || []).includes('user')) { toggleFeedLike(pid); flyHeart(pid); }
 else flyHeart(pid);
 }
 img._lastTap = now;
 }, true);

 // ── input events ──
 const chatInput = document.getElementById('pp-input');
 if (chatInput) {
 chatInput.addEventListener('input', function () {
 this.style.height = 'auto';
 this.style.height = Math.min(120, this.scrollHeight) + 'px';
 const tid = curTid();
 if (tid) saveDraft(tid, this.value);
 });
 chatInput.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ppSendUserMessage(); } });
 }
 const callInput = document.getElementById('pp-call-input');
 if (callInput) {
 callInput.addEventListener('input', function () { this.style.height = 'auto'; this.style.height = Math.min(90, this.scrollHeight) + 'px'; });
 callInput.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ppCallSend(); } });
 }
 const cmtInput = document.getElementById('pp-comment-input');
 if (cmtInput) {
 cmtInput.addEventListener('input', function () { this.style.height = 'auto'; this.style.height = Math.min(100, this.scrollHeight) + 'px'; });
 cmtInput.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ppSendComment(); } });
 }
 document.getElementById('pp-msg-search')?.addEventListener('input', e => { ppMsgFilter = e.target.value.trim(); renderContactList(); });
 document.getElementById('pp-chat-search')?.addEventListener('input', e => { ppChatFilter = e.target.value.trim(); renderThread(); });

 // change/input delegation
 frame.addEventListener('change', e => {
 const id = e.target.id;
 const cfg = getCfg();
 const v = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
 // ★ 1.3.0 สวิตช์โมดูล bridge
 const bmod = e.target.dataset && e.target.dataset.bmod;
 if (bmod) {
  cfg.bridgeMods[bmod] = !!v;
  saveCfg();
  const tot = document.getElementById('pp-tok-total');
  if (tot) tot.textContent = ppTokLabel(ppBridgeActiveTotal());
  const chip = e.target.closest('.pp-cell')?.querySelector('.pp-tokchip');
  if (chip) chip.classList.toggle('on', !!v);
  return;
 }
 const map = {
 'pp-set-dramaon': () => { cfg.dramaEnabled = v; saveCfg(); renderPhoneSettings(); },
 'pp-set-callhist': () => { cfg.callHistoryOpen = v; },
 'pp-set-botgroup': () => { cfg.botCanMakeGroup = v; },
 'pp-set-botwallet': () => { cfg.botCanSetWallet = v; },
 'pp-set-nicknotify': () => { cfg.nicknameNotify = v; },
 'pp-set-peek': () => { cfg.unsendPeekEnabled = v; },
 'pp-set-climit': () => { cfg.contactSendLimit = Math.max(1, Math.min(60, parseInt(v, 10) || 12)); },
 'pp-set-logstory': () => { cfg.logToStory = v; },
 'pp-set-logidle': () => { cfg.logIdleNote = v; },
 'pp-set-logminor': () => { cfg.logMinorActions = v; },
 'pp-set-logwrap': () => { cfg.logWrapMode = v; },
 'pp-set-logmax': () => { cfg.logMaxEvents = Math.max(5, Math.min(200, parseInt(v, 10) || 60)); },
 'pp-set-universe': () => { cfg.sharedUniverse = v; },
 'pp-set-affectrp': () => { cfg.universeAffectsRP = v; },
 'pp-set-singlecall': () => { cfg.singleRequestMode = v; },
 'pp-set-autosync': () => { cfg.autoSyncEnabled = v; if (v) cfg.universeAffectsRP = true; },
 'pp-set-syncreceipt': () => { cfg.syncReceipts = v; },
 'pp-set-syncmax': () => { cfg.syncMaxEvents = Math.max(1, Math.min(20, parseInt(v, 10) || 8)); },
 'pp-set-botreply': () => { cfg.allowBotReplyOnPhone = v; },
 'pp-set-strictnpc': () => { cfg.strictNpcScope = v; renderContactList(); },
 'pp-set-keykeep': () => { cfg.keyKeepTurns = Math.max(0, Math.min(20, parseInt(v, 10) || 0)); },
 'pp-set-dark': () => { cfg.theme = v ? 'dark' : 'light'; applyTheme(); },
 'pp-set-fab': () => { cfg.showFab = v; applyFab(); },
 'pp-set-fabbadge': () => { cfg.showFabBadge = v; ppUpdateLogBadge(); },
 'pp-set-island': () => { cfg.dynamicIsland = v; applyIsland(); },
 'pp-set-scope2': () => { cfg.islandScope = v ? 'always' : 'phone'; },
 'pp-set-botcall': () => { cfg.botCallKeyword = v; },
 'pp-set-caption': () => { cfg.imageCaptionMode = v; },
 'pp-set-personamode': () => { cfg.userPersonaMode = v; saveCfg(); renderPhoneSettings(); },
 'pp-set-sharedpersona': () => { cfg.sharedUserPersonaId = v; },
 'pp-set-avauto': () => { cfg.userAvatarMode = v ? 'auto' : 'custom'; saveCfg(); refreshUserAvatar().then(renderPhoneSettings); },
 'pp-acc-lock': () => { cfg.accountLocked = v; ppLog('account', v ? 'ล็อคบัญชีฟีด' : 'ปลดล็อคบัญชีฟีด'); saveCfg(); renderAccountSettings(); },
 'pp-acc-vis': () => { cfg.postVisibilityDefault = v; ppLog('account', `ตั้งค่าเริ่มต้นการมองเห็นโพสต์เป็น "${visibilityLabel(v)}"`); },
 'pp-w-cur': () => { cfg.walletCurrency = v; saveCfg(); renderWallet(); updateHomeWidgets(); },
 'pp-w-perchat': () => { cfg.walletPerChat = v; saveCfg(); renderWallet(); updateHomeWidgets(); ppToast(v ? 'แยกกระเป๋าเงินตามแชทแล้ว' : 'ใช้กระเป๋าเงินร่วมทุกแชท'); },
 'pp-set-ghost': () => { cfg.ghostEnabled = v; saveCfg(); renderPhoneSettings(); },
 'pp-set-drama': () => { cfg.dramaLevel = v; },
 'pp-set-ghostdm': () => { cfg.ghostDmChance = Math.max(0, Math.min(5, parseInt(v, 10) || 0)); },
 'pp-w-limit': () => { cfg.walletDailyLimit = Math.max(0, parseInt(v, 10) || 0); },
 'pp-p-share': () => { cfg.periodShareBot = v; ppLog('period', v ? 'เปิดให้บอทรับรู้รอบเดือน' : 'ปิดไม่ให้บอทรับรู้รอบเดือน'); saveCfg(); renderPeriod(); },
 'pp-p-care': () => { cfg.periodCareLevel = v; saveCfg(); renderPeriod(); },
 'pp-p-cyclelen': () => { cfg.periodCycleLen = Math.max(15, Math.min(60, parseInt(v, 10) || 28)); },
 'pp-p-dur': () => { cfg.periodDuration = Math.max(1, Math.min(14, parseInt(v, 10) || 5)); },
 'pp-npc-toggle': () => {
 if (!ppActiveContact) return;
 const c2 = findContact(ppActiveContact.id);
 if (c2) { c2.npc = v; ppActiveContact.npc = v; ppToast(v ? 'ย้ายไปหมวด NPC' : 'ย้ายไปหมวดตัวละคร'); }
 },
 'pp-bubble-glass': () => { if (ppActiveContact) { getChatStyle(ppActiveContact.id).bubbleGlass = v; applyChatStyle(); } },
 'pp-cs-tail': () => { if (ppActiveContact) { getChatStyle(ppActiveContact.id).tail = v; applyChatStyle(); } },
 'pp-cs-stickerpack': () => { if (ppActiveContact) getChatStyle(ppActiveContact.id).stickerPack = v; },
 'pp-np-vis': () => { if (ppNewPostDraft) { ppNewPostDraft.visibility = v; renderNewPost(); } },
 'pp-np-know': () => { if (ppNewPostDraft) ppNewPostDraft.knowEachOther = v; },
 'pp-group-know': () => { if (ppGroupDraft) ppGroupDraft.knowEachOther = v; },
 'pp-group-replymode': () => { if (ppGroupDraft) ppGroupDraft.replyMode = v; },
 };
 if (map[id]) { map[id](); saveCfg(); }
 });
 frame.addEventListener('input', e => {
 const id = e.target.id;
 const cfg = getCfg();
 if (id === 'pp-set-accent') { cfg.accent = e.target.value; saveCfg(); applyTheme(); }
 if (id === 'pp-set-blur') { cfg.homeBlur = +e.target.value; saveCfg(); applyWallpaper(); }
 if (id === 'pp-set-ringtone') { cfg.ringtoneUrl = e.target.value.trim(); saveCfg(); }
 if (id === 'pp-bubble-color' && ppActiveContact) { const st = getChatStyle(ppActiveContact.id); st.bubble = e.target.value; st.bubbleImg = false; saveCfg(); applyChatStyle(); }
 if (id === 'pp-text-color' && ppActiveContact) { getChatStyle(ppActiveContact.id).textColor = e.target.value; saveCfg(); applyChatStyle(); }
 if (id === 'pp-cs-msgblur' && ppActiveContact) { getChatStyle(ppActiveContact.id).msgBlur = +e.target.value; saveCfg(); applyChatStyle(); }
 if (id === 'pp-explore-search') {
 const q2 = e.target.value.trim().toLowerCase();
 document.querySelectorAll('#pp-feed-scroll .pp-gridcell').forEach(el => {
 const p = findPost(el.dataset.postopen);
 const hit = !q2 || (p && (String(p.text || '').toLowerCase().includes(q2) || postAuthorLabel(p).toLowerCase().includes(q2)));
 el.style.display = hit ? '' : 'none';
 });
 }
 });

 // file inputs
 // ★ ผูก event แบบ delegate บน frame (ไม่ใช่ getElementById ตรง ๆ) เพราะ input พวกนี้
 // อยู่ใน body ที่ถูก re-render ทิ้งแล้วสร้างใหม่บ่อย ๆ (renderChatSettings, renderGroupSettings,
 // renderProfileEdit, renderPhoneSettings) — ผูกครั้งเดียวตอนบูตแล้วจะหลุดทันทีที่ re-render ครั้งแรก
 const fileToMedia = (inputId, key, after) => {
 frame.addEventListener('change', async e => {
 if (e.target.id !== inputId) return;
 const f = e.target.files && e.target.files[0];
 e.target.value = '';
 if (!f) return;
 const dataUrl = await ppReadImageFile(f);
 if (!dataUrl) { ppToast('อ่านไฟล์รูปไม่ได้'); return; }
 const ok = await saveMedia(key(), dataUrl);
 if (!ok) { ppToast('บันทึกรูปไม่สำเร็จ (พื้นที่เก็บข้อมูลอาจเต็ม) ลองรูปที่เล็กลง'); return; }
 if (after) await after();
 });
 };
 fileToMedia('pp-set-wp-file', () => 'home-wp', async () => { getCfg().wallpaper = 'custom'; saveCfg(); applyWallpaper(); renderPhoneSettings(); ppToast('ตั้งวอลเปเปอร์แล้ว'); });
 fileToMedia('pp-user-av-pick', () => 'user-avatar', async () => { getCfg().userAvatarMode = 'custom'; saveCfg(); await refreshUserAvatar(); renderPhoneSettings(); ppToast('ตั้งรูปโปรไฟล์แล้ว'); });
 fileToMedia('pp-prof-av-pick', () => 'user-avatar', async () => { getCfg().userAvatarMode = 'custom'; saveCfg(); await refreshUserAvatar(); renderProfileEdit(); ppLog('account', 'เปลี่ยนรูปโปรไฟล์'); ppToast('เปลี่ยนรูปแล้ว'); });
 fileToMedia('pp-chatbg-file', () => 'chatbg-' + (curTid() || 'x'), async () => {
 const tid = curTid();
 if (tid) {
 getChatStyle(tid).bg = 'custom'; saveCfg(); applyChatStyle();
 if (ppCurrentScreen === 'groupsettings') renderGroupSettings(); else renderChatSettings();
 ppToast('ตั้งพื้นหลังแล้ว');
 }
 });
 fileToMedia('pp-bubbleimg-file', () => 'bubbleimg-' + (ppActiveContact ? ppActiveContact.id : 'x'), async () => {
 if (ppActiveContact) { getChatStyle(ppActiveContact.id).bubbleImg = true; saveCfg(); applyChatStyle(); ppToast('ตั้งรูปฟองแล้ว'); }
 });
 document.getElementById('pp-chat-img-file')?.addEventListener('change', e => { const f = e.target.files?.[0]; if (f) ppHandleChatImage(f); e.target.value = ''; });
 document.getElementById('pp-story-img-file')?.addEventListener('change', e => { const f = e.target.files?.[0]; if (f) ppAddImageStory(f); e.target.value = ''; });
 document.getElementById('pp-newpost-img-file')?.addEventListener('change', e => { if (e.target.files?.length) ppNewPostPickImages(e.target.files); e.target.value = ''; });
 // ★ 1.4.1 input สติกเกอร์ผูก listener ในตัวเองแล้ว (ppStickerFileInput) — เรียกครั้งเดียวให้มันมีอยู่
 ppStickerFileInput();
 document.getElementById('pp-sticker-import-file')?.addEventListener('change', e => {
 const f = e.target.files?.[0]; e.target.value = '';
 if (!f) return;
 const r = new FileReader();
 r.onload = () => ppImportStickersFromText(String(r.result || ''));
 r.onerror = () => ppToast('อ่านไฟล์ไม่ได้');
 r.readAsText(f);
 });
 document.body.addEventListener('change', e => {
 if (e.target.id === 'pp-np-file' && e.target.files?.length) { ppNewPostPickImages(e.target.files); e.target.value = ''; }
 });

 // swipe-to-reply
 const msgs = document.getElementById('pp-msgs');
 if (msgs) bindSwipeReply(msgs);
}

// ══════════════════════════════════════════════════════════
// BOOT
// ══════════════════════════════════════════════════════════
window.PP_OPEN = ppOpen;
window.PP_LOADED = 'parsed';
(function boot() {
 injectCSS();
 let tries = 0;
 const timer = setInterval(() => {
 tries++;
 const host = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
 if (host) {
 clearInterval(timer);
 try {
 ppDetect(true);
 injectFab();
 injectPhone();
 injectExternalIsland();
 registerSettingsPanel();
 startClock();
 refreshUserAvatar();
 pruneStories();
 ppStartSyncWatchdog();
 try {
 const c = ctx();
 if (c && c.eventSource && c.event_types) {
 // Parse only after generation is complete; render events can fire mid-stream.
 if (c.event_types.GENERATION_STARTED) c.eventSource.on(c.event_types.GENERATION_STARTED, () => { ppStGenBusy = true; ppStGenBusySince = Date.now(); });
 // ★ 1.4.4 ให้ GENERATION_ENDED เป็นตัวหลักตัวเดียว — ตัวอื่นแค่เก็บตก
 if (c.event_types.GENERATION_ENDED) c.eventSource.on(c.event_types.GENERATION_ENDED, () => { ppStGenBusy = false; ppStGenBusySince = 0; ppScheduleMainSync(250); });
 if (c.event_types.GENERATION_STOPPED) c.eventSource.on(c.event_types.GENERATION_STOPPED, () => { ppStGenBusy = false; ppStGenBusySince = 0; ppBridgeExpected = false; ppCancelActionBatch(); ppMaskSyncFramesInDom(document); });
 if (c.event_types.CHARACTER_MESSAGE_RENDERED) c.eventSource.on(c.event_types.CHARACTER_MESSAGE_RENDERED, () => ppScheduleMainSync(900));
 if (c.event_types.CHAT_CHANGED) c.eventSource.on(c.event_types.CHAT_CHANGED, () => {
  ppBridgeExpected = false; ppCancelActionBatch(); getCfg().logStamps = []; saveCfg();
  if (ppCurrentScreen === 'chat' && ppActiveContact && ppActiveContact.id === currentCharacterId()) renderThread();
  updateHomeWidgets();
 });
 }
 } catch (e) { console.warn('[pocket-phone] event hook', e); }
 // ★ 1.3.0 วัดโทเคนล่วงหน้าเงียบ ๆ (tokenizer ในเครื่อง ไม่ยิง API)
 setTimeout(() => { ppMeasureBridgeTokens(false).catch(() => {}); }, 3000);
 window.PP_LOADED = 'ok';
 console.log(`[pocket-phone] ${PP_VERSION} loaded — bridge modules + token meter พร้อม`);
 console.log('[pocket-phone] เครื่องมือ: PP_DIAG() · PP_PREVIEW_LOG() · PP_STRIP_ALL() · PP_STAMP_NOW()');
 } catch (e) {
 window.PP_LOADED = 'error';
 console.error('[pocket-phone] boot error', e);
 }
 } else if (tries > 60) {
 clearInterval(timer);
 window.PP_LOADED = 'no-host';
 console.warn('[pocket-phone] ไม่พบจุด mount หลัง 30 วิ');
 }
 }, 500);
 const wandTimer = setInterval(() => { if (injectWandButton()) clearInterval(wandTimer); }, 700);
 setTimeout(() => clearInterval(wandTimer), 45000);
 try {
 const mo = new MutationObserver(() => { if (!document.getElementById('pp-wand-btn')) injectWandButton(); });
 mo.observe(document.body, { childList: true, subtree: true });
 } catch {}
})();
