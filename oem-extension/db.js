// db.js — IndexedDB wrapper cho OEM Crawler (dựa theo mẫu db.js của extension ToyoDIY, đổi store = 'oem_crawler').
// Dùng làm KHO KEY-VALUE bền vững để RESUME được sau khi service worker bị Chrome kill:
//   - key 'state'    → { running, current_index, done, errors, found, api_base, delay, updated_at }
//   - key 'oem_list' → { list: ["48510-09520", ...] }  (danh sách mã nạp từ CSV)
//   - key 'results'  → { map: { "<oem>": {imported, vehicles, ts} } }  (đã xử lý — tránh làm lại)
// Nạp vào service worker bằng importScripts('db.js') (background.js là classic worker, KHÔNG phải module).

const OEM_DB_NAME  = 'oem_crawler';
const OEM_DB_VER   = 1;
const OEM_DB_STORE = 'oem_crawler';   // 1 object store keyPath='k'

function openOemDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(OEM_DB_NAME, OEM_DB_VER);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(OEM_DB_STORE)) {
        db.createObjectStore(OEM_DB_STORE, { keyPath: 'k' });
      }
    };
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror   = (e) => reject(e.target.error);
  });
}

// Đọc value theo key (trả undefined nếu chưa có)
async function oemDbGet(key) {
  const db = await openOemDB();
  return new Promise((resolve, reject) => {
    const r = db.transaction(OEM_DB_STORE, 'readonly').objectStore(OEM_DB_STORE).get(key);
    r.onsuccess = (e) => resolve(e.target.result ? e.target.result.v : undefined);
    r.onerror   = (e) => reject(e.target.error);
  });
}

// Ghi (upsert) value theo key
async function oemDbSet(key, value) {
  const db = await openOemDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(OEM_DB_STORE, 'readwrite');
    tx.objectStore(OEM_DB_STORE).put({ k: key, v: value });
    tx.oncomplete = () => resolve(true);
    tx.onerror    = (e) => reject(e.target.error);
  });
}

// Xóa 1 key
async function oemDbDelete(key) {
  const db = await openOemDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(OEM_DB_STORE, 'readwrite');
    tx.objectStore(OEM_DB_STORE).delete(key);
    tx.oncomplete = () => resolve(true);
    tx.onerror    = (e) => reject(e.target.error);
  });
}

// Xóa TẤT CẢ (reset toàn bộ queue + state)
async function oemDbClear() {
  const db = await openOemDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(OEM_DB_STORE, 'readwrite');
    tx.objectStore(OEM_DB_STORE).clear();
    tx.oncomplete = () => resolve(true);
    tx.onerror    = (e) => reject(e.target.error);
  });
}
