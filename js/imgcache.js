// imgcache.js —— 卡牌图片本地缓存（IndexedDB + 对象 URL）
// 首次加载时从网络抓取全部卡图存入 IndexedDB；之后每次运行直接读本地，
// 不再重复下载。若缓存不可用则自动回退到普通网络地址。
'use strict';

import { ALL_IMG_KEYS, IMG_DIR } from './cards.js';

const DB_NAME = 'catcard-assets';
const DB_VERSION = 1;   // 卡图更新时 +1 以强制刷新缓存
const STORE = 'imgs';

const urlMap = new Map();   // key -> objectURL
const pending = new Map();  // key -> promise

let db = null;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbGet(key) {
  return new Promise((resolve) => {
    const tx = db.transaction(STORE, 'readonly');
    const rq = tx.objectStore(STORE).get(key);
    rq.onsuccess = () => resolve(rq.result || null);
    rq.onerror = () => resolve(null);
  });
}

function idbPut(key, blob) {
  return new Promise((resolve) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(blob, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

async function loadOne(key) {
  if (urlMap.has(key)) return urlMap.get(key);
  if (pending.has(key)) return pending.get(key);
  const p = (async () => {
    // 1. 本地缓存
    try {
      if (!db) { try { db = await openDB(); } catch (e) { db = null; } }
      if (db) {
        const blob = await idbGet(key);
        if (blob) {
          const url = URL.createObjectURL(blob);
          urlMap.set(key, url);
          return url;
        }
      }
    } catch (e) { /* 忽略，走网络 */ }
    // 2. 网络下载并写入缓存
    try {
      const resp = await fetch(`${IMG_DIR}${key}.png`, { cache: 'force-cache' });
      if (!resp.ok) throw new Error('http ' + resp.status);
      const blob = await resp.blob();
      if (db) await idbPut(key, blob);
      const url = URL.createObjectURL(blob);
      urlMap.set(key, url);
      return url;
    } catch (e) {
      return `${IMG_DIR}${key}.png`; // 最终回退普通地址
    }
  })();
  pending.set(key, p);
  const url = await p;
  pending.delete(key);
  return url;
}

// 应用启动时预热全部卡图（后台进行，不阻塞渲染）
export function initImageCache() {
  if (typeof indexedDB === 'undefined') return Promise.resolve();
  return Promise.all(ALL_IMG_KEYS.map(loadOne)).catch(() => {});
}

// 同步取图地址：已缓存/已预热 → 对象 URL；否则回退网络地址（图片照常加载）
export function imgSrc(key) {
  return urlMap.get(key) || `${IMG_DIR}${key}.png`;
}

// 供调试/测试
export function imageCacheStats() {
  return { cached: urlMap.size, total: ALL_IMG_KEYS.length };
}