/**
 * translate_offline.mjs — TOOL DỊCH TÊN OFFLINE (KHÔNG gọi API)
 * Dùng chung cho worker dịch. Tái sử dụng từ điển VIET + rule phanh của import-name-vi.mjs,
 * bổ sung: tra theo mã OEM (translation_lookup_v4.json) + lớp rule từ khóa mở rộng.
 *
 * translateOffline(nameEn, oemCode) → string (tên tiếng Việt) hoặc null nếu không dịch được.
 */
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');

// ---- 1) Bảng tra theo MÃ OEM (translation_lookup_v4.json) ----
let CODE_MAP = new Map();
try {
  const raw = JSON.parse(readFileSync(join(ROOT, 'translation_lookup_v4.json'), 'utf8'));
  for (const [code, vi] of Object.entries(raw)) {
    if (code && vi) CODE_MAP.set(normCode(code), vi);
  }
} catch (e) {
  console.warn('[translate_offline] Không đọc được translation_lookup_v4.json:', e.message);
}
function normCode(c) { return String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); }

// ---- 2) Từ điển EXACT theo tên tiếng Anh (copy nguyên từ import-name-vi.mjs) ----
const VIET = {"ABSORBER, INNER REAR VIEW MIRROR":"Giảm chấn gương chiếu hậu trong","ACCESSORY SET, HEATER":"Bộ phụ kiện sưởi","ALTERNATOR ASSY":"Cụm máy phát điện","ARM ASSY, WINDSHIELD WIPER":"Cụm cần gạt nước kính trước","BACK ASSY FRONT SEAT LH(FOR SEPARATE TYPE)":"Cụm lưng ghế trước trái (loại tách rời)","BACK ASSY FRONT SEAT RH(FOR SEPARATE TYPE)":"Cụm lưng ghế trước phải (loại tách rời)","BACK ASSY REAR SEAT (FOR BENCH TYPE)":"Cụm lưng ghế sau (loại băng ghế)","BATTERY":"Ắc quy","BEARING SET, CAMSHAFT":"Bộ bạc trục cam","BEARING SET, CONNECTING ROD":"Bộ bạc biên","BEARING SET, CRANKSHAFT":"Bộ bạc trục khuỷu","BEARING, CONNECTING ROD":"Bạc biên","BEARING, CRANKSHAFT":"Bạc trục khuỷu","BEARING, WATER PUMP":"Bạc đạn bơm nước","BLADE ASSY, WINDSHIELD WIPER":"Cụm lưỡi gạt nước kính trước","BLADE, WINDSHIELD WIPER":"Lưỡi gạt nước kính trước","BLOCK ASSY, FUSE":"Cụm hộp cầu chì","BOLT, CONNECTING ROD":"Bu lông biên","BOLT, FLYWHEEL SETTING":"Bu lông bánh đà","BRAKE PAD KIT, DISC":"Bộ má phanh đĩa","BRAKE PAD KIT":"Bộ má phanh","BRAKE PADS FOR DISC BRAKES":"Má phanh đĩa","BRAKE SHOE SET, REAR":"Bộ guốc phanh sau","SHOE SET, BRAKE":"Bộ guốc phanh","SHOE SET, REAR":"Bộ guốc phanh sau","DISC, FRONT BRAKE":"Đĩa phanh trước","DISC, REAR BRAKE":"Đĩa phanh sau","DRUM, REAR BRAKE":"Tăng bua phanh sau","DRUM, BRAKE":"Tăng bua phanh","CYLINDER ASSY, BRAKE MASTER":"Cụm xy lanh tổng phanh","BOOSTER ASSY, BRAKE":"Cụm bầu trợ lực phanh","HOSE, FLEXIBLE, FRONT BRAKE":"Ống dầu phanh mềm trước","HOSE, FLEXIBLE, REAR BRAKE":"Ống dầu phanh mềm sau","BUMPER ASSY, FRONT":"Cụm cản trước","BUMPER ASSY, REAR":"Cụm cản sau","CAMSHAFT":"Trục cam","CAP ASSY, FUEL TANK":"Nắp bình xăng","CAP SUB-ASSY, AIR CLEANER":"Nắp lọc gió","CAP SUB-ASSY, RADIATOR":"Nắp két nước","CARBURETOR ASSY":"Cụm chế hòa khí","CARBURETOR KIT":"Bộ sửa chữa chế hòa khí","CLEANER ASSY, AIR":"Cụm lọc gió","COIL ASSY, IGNITION":"Cụm bô-bin đánh lửa","COVER FRONT SEAT CUSHION LH(FOR SEPARATE TYPE)":"Bọc đệm ghế trước trái (loại tách rời)","COVER FRONT SEAT CUSHION RH(FOR SEPARATE TYPE)":"Bọc đệm ghế trước phải (loại tách rời)","COVER FRONT SEATBACK LH(FOR SEPARATE TYPE)":"Bọc lưng ghế trước trái (loại tách rời)","COVER FRONT SEATBACK RH(FOR SEPARATE TYPE)":"Bọc lưng ghế trước phải (loại tách rời)","COVER REAR SEAT CUSHION (FOR BENCH TYPE)":"Bọc đệm ghế sau (loại băng ghế)","COVER REAR SEATBACK (FOR BENCH TYPE)":"Bọc lưng ghế sau (loại băng ghế)","COVER SUB-ASSY, CYLINDER HEAD":"Nắp quy lát","CRANKSHAFT":"Trục khuỷu","CUSHION ASSY FRONT SEAT LH (FOR SEPARATE TYPE)":"Cụm đệm ghế trước trái (loại tách rời)","CUSHION ASSY FRONT SEAT RH(FOR SEPARATE TYPE)":"Cụm đệm ghế trước phải (loại tách rời)","CUSHION ASSY REAR SEAT (FOR BENCH TYPE)":"Cụm đệm ghế sau (loại băng ghế)","DISTRIBUTOR ASSY":"Cụm bộ chia điện","ELEMENT SUB-ASSY AIR CLEANER FILTER":"Lõi lọc gió","ENGINE ASSY, PARTIAL":"Cụm động cơ (bán phần)","FAN":"Quạt làm mát","FAN SUB-ASSY, HEATER BLOWER":"Cụm quạt sưởi","FENDER SUB-ASSY, FRONT LH":"Cụm chắn bùn trước trái","FENDER SUB-ASSY, FRONT RH":"Cụm chắn bùn trước phải","FILTER ASSY, FUEL":"Cụm lọc xăng","FILTER SUB-ASSY, OIL":"Cụm lọc dầu","FLYWHEEL SUB-ASSY":"Cụm bánh đà","GASKET KIT, ENGINE OVERHAUL":"Bộ ron đại tu động cơ","GASKET KIT, ENGINE VALVE GRIND":"Bộ ron mài xu páp","GASKET, CYLINDER HEAD":"Ron quy lát","GASKET, CYLINDER HEAD COVER":"Ron nắp quy lát","GASKET, EXHAUST PIPE":"Ron ống xả","GASKET, FUEL PUMP":"Ron bơm xăng","GASKET, OIL PAN":"Ron cạt-te dầu","GASKET, WATER PUMP":"Ron bơm nước","GASKET, WATER OUTLET":"Ron cổ nước","GEAR, FLYWHEEL RING":"Vành răng bánh đà","GLASS, WINDSHIELD":"Kính chắn gió trước","GRILLE, RADIATOR":"Lưới tản nhiệt","HEADLAMP ASSY, LH":"Cụm đèn pha trái","HEADLAMP ASSY, RH":"Cụm đèn pha phải","HEATER ASSY":"Cụm sưởi","HOOD SUB-ASSY":"Cụm nắp capô","JACK ASSY":"Cụm kích xe","LAMP ASSY, FRONT TURN SIGNAL, LH":"Cụm đèn xi nhan trước trái","LAMP ASSY, FRONT TURN SIGNAL, RH":"Cụm đèn xi nhan trước phải","LAMP ASSY, REAR COMBINATION, LH":"Cụm đèn hậu trái","LAMP ASSY, REAR COMBINATION, RH":"Cụm đèn hậu phải","LAMP ASSY, ROOM, NO.1":"Cụm đèn trần số 1","LIFTER, VALVE":"Con đội xu páp","LOCK ASSY, FRONT DOOR, LH":"Cụm khóa cửa trước trái","LOCK ASSY, FRONT DOOR, RH":"Cụm khóa cửa trước phải","LOCK ASSY, HOOD":"Cụm khóa capô","MAT, FLOOR, FRONT":"Thảm sàn trước","MAT, FLOOR, REAR":"Thảm sàn sau","METER ASSY, COMBINATION":"Cụm đồng hồ tổ hợp","MIRROR ASSY, INNER REAR VIEW":"Gương chiếu hậu trong xe","MIRROR ASSY, OUTER REAR VIEW, LH":"Gương chiếu hậu ngoài trái","MIRROR ASSY, OUTER REAR VIEW, RH":"Gương chiếu hậu ngoài phải","MUFFLER ASSY":"Cụm bình giảm thanh","PISTON SUB-ASSY, W/PIN":"Cụm piston kèm chốt","PLUG, SPARK":"Bu-gi","PLUG KIT, SPARK":"Bộ bu-gi","PUMP ASSY, ENGINE WATER":"Cụm bơm nước động cơ","PUMP ASSY, FUEL":"Cụm bơm xăng","PUMP ASSY, OIL":"Cụm bơm dầu","PUMP ASSY, WATER":"Cụm bơm nước","PUMP KIT, FUEL":"Bộ sửa chữa bơm xăng","PUMP KIT, WATER":"Bộ bơm nước","RADIATOR ASSY":"Két nước làm mát","REGULATOR SUB-ASSY FRONT DOOR WINDOW LH":"Cụm nâng hạ kính cửa trước trái","REGULATOR SUB-ASSY FRONT DOOR WINDOW RH":"Cụm nâng hạ kính cửa trước phải","RING SET, OIL":"Bộ xéc măng dầu","RING SET, PISTON":"Bộ xéc măng piston","ROD SUB-ASSY, CONNECTING":"Cụm phụ thanh biên","ROD, VALVE PUSH":"Đũa đẩy xu páp","SEAL, ENGINE REAR OIL":"Phớt dầu trục khuỷu sau","SEAT, EXHAUST VALVE":"Đế xu páp xả","SEAT, INTAKE VALVE":"Đế xu páp hút","SPEAKER ASSY, FRONT NO.1":"Cụm loa trước số 1","SPEEDOMETER ASSY":"Cụm đồng hồ tốc độ","STARTER ASSY":"Cụm đề (máy khởi động)","SWITCH ASSY, IGNITION OR STARTER":"Cụm công tắc khởi động","SWITCH ASSY, STOP LAMP":"Cụm công tắc đèn phanh","SWITCH ASSY, TURN SIGNAL":"Cụm công tắc xi nhan","SWITCH ASSY, WINDSHIELD WIPER":"Cụm công tắc gạt nước","TANK ASSY, FUEL":"Cụm bình xăng","TANK ASSY, RADIATOR RESERVE":"Cụm bình dự phòng nước làm mát","THERMOSTAT":"Van hằng nhiệt","VALVE, EXHAUST":"Xu páp xả","VALVE, INTAKE":"Xu páp hút","VALVE, OIL PUMP RELIEF":"Van tràn bơm dầu","VISOR ASSY, LH":"Tấm che nắng trái","VISOR ASSY, RH":"Tấm che nắng phải","WEATHERSTRIP, FRONT DOOR, LH":"Gioăng cửa trước trái","WEATHERSTRIP, FRONT DOOR, RH":"Gioăng cửa trước phải","WEATHERSTRIP, WINDSHIELD":"Gioăng kính chắn gió","WRENCH, SPARK PLUG":"Cờ lê bu-gi"};

// ---- 3) Rule phanh (copy từ import-name-vi.mjs) ----
function ruleBrake(nameEn) {
  const lo = nameEn.toLowerCase();
  if (lo.includes('brake pad') && lo.includes('rear')) return 'Má phanh đĩa sau';
  if (lo.includes('brake pad') && lo.includes('front')) return 'Má phanh đĩa trước';
  if (lo.includes('brake pad')) return 'Má phanh đĩa';
  if (lo.includes('pad kit') && lo.includes('disc')) return 'Bộ má phanh đĩa';
  if (lo.includes('brake shoe') && lo.includes('rear')) return 'Guốc phanh sau';
  if (lo.includes('brake shoe') && lo.includes('front')) return 'Guốc phanh trước';
  if (lo.includes('shoe set') && lo.includes('rear')) return 'Bộ guốc phanh sau';
  if (lo.includes('shoe set')) return 'Bộ guốc phanh';
  if (lo.includes('disc') && lo.includes('rear') && lo.includes('brake')) return 'Đĩa phanh sau';
  if (lo.includes('disc') && lo.includes('front') && lo.includes('brake')) return 'Đĩa phanh trước';
  if (lo.includes('drum') && lo.includes('rear')) return 'Tăng bua phanh sau';
  if (lo.includes('drum') && lo.includes('brake')) return 'Tăng bua phanh';
  return null;
}

// ---- 4) Lớp rule TỪ KHÓA mở rộng — phủ tên lạ theo thuật ngữ thợ VN ----
// Mỗi mục: [regex thành phần chính, tên VN gốc]. Có xử lý hậu tố trước/sau/trái/phải.
const KW = [
  [/\bshock absorber\b|\bshock absorber assy\b|\babsorber assy,?\s*shock\b/, 'Giảm sóc'],
  [/\btie rod end\b|\brod end sub-?assy,?\s*tie\b/, 'Rô tuyn lái ngoài'],
  [/\btie rod\b/, 'Rô tuyn lái trong'],
  [/\bmaster cylinder\b|\bcylinder assy,?\s*brake master\b/, 'Tổng phanh'],
  [/\bwheel cylinder\b/, 'Xy lanh phanh bánh xe'],
  [/\balternator\b/, 'Máy phát điện'],
  [/\bstarter\b/, 'Máy đề'],
  [/\bwater pump\b|\bpump assy,?\s*(engine\s+)?water\b/, 'Bơm nước'],
  [/\boil pump\b|\bpump assy,?\s*oil\b/, 'Bơm dầu'],
  [/\bfuel pump\b|\bpump assy,?\s*fuel\b/, 'Bơm xăng'],
  [/\btiming belt\b/, 'Dây cam'],
  [/\btiming chain\b/, 'Xích cam'],
  [/\bv-?belt\b|\bfan belt\b|\bdrive belt\b/, 'Dây curoa'],
  [/\bspark plug\b|\bplug,?\s*spark\b/, 'Bugi'],
  [/\bignition coil\b|\bcoil assy,?\s*ignition\b/, 'Mô bin đánh lửa'],
  [/\bball joint\b/, 'Rô tuyn'],
  [/\bcontrol arm\b|\bsuspension arm\b|\barm sub-?assy,?\s*(front|rear)?\s*suspension\b/, 'Càng A'],
  [/\bstrut mount\b|\bsupport sub-?assy,?\s*(front|rear)?\s*suspension\b/, 'Bát bèo'],
  [/\bwheel hub\b|\bhub\s*&?\s*bearing\b|\bhub assy\b/, 'Moay ơ'],
  [/\bclutch disc\b|\bdisc assy,?\s*clutch\b/, 'Đĩa côn'],
  [/\bpressure plate\b|\bcover assy,?\s*clutch\b/, 'Bàn ép'],
  [/\brelease bearing\b|\bbearing assy,?\s*clutch release\b/, 'Bi tê'],
  [/\bair cleaner\b|\bair filter\b|\belement sub-?assy air\b/, 'Lọc gió'],
  [/\boil filter\b|\bfilter sub-?assy,?\s*oil\b/, 'Lọc dầu'],
  [/\bfuel filter\b|\bfilter assy,?\s*fuel\b/, 'Lọc xăng'],
  [/\bradiator\b/, 'Két nước'],
  [/\bthermostat\b/, 'Van hằng nhiệt'],
  [/\bcondenser\b/, 'Dàn nóng điều hòa'],
  [/\bevaporator\b/, 'Dàn lạnh điều hòa'],
  [/\bcompressor\b/, 'Lốc lạnh'],
  [/\bcamshaft\b/, 'Trục cam'],
  [/\bcrankshaft\b/, 'Trục khuỷu'],
  [/\bcylinder head\b/, 'Nắp quy lát'],
  [/\bpiston\b/, 'Piston'],
  [/\bconnecting rod\b/, 'Thanh biên'],
  [/\bflywheel\b/, 'Bánh đà'],
  [/\bmuffler\b/, 'Bình giảm thanh'],
  [/\bthrottle body\b/, 'Bướm ga'],
  [/\binjector\b|\bnozzle\b/, 'Kim phun'],
  [/\bfuel tank\b|\btank assy,?\s*fuel\b/, 'Bình xăng'],
  [/\bheadlamp\b|\bhead lamp\b/, 'Đèn pha'],
  [/\btail ?lamp\b|\brear combination lamp\b/, 'Đèn hậu'],
  [/\bturn signal\b/, 'Đèn xi nhan'],
  [/\bwindshield\b.*\bwiper\b|\bwiper blade\b/, 'Gạt mưa'],
  [/\bwindshield\b|\bwind shield\b/, 'Kính chắn gió'],
  [/\bfender\b/, 'Chắn bùn'],
  [/\bhood\b/, 'Nắp capô'],
  [/\bbumper\b/, 'Cản'],
  [/\bmirror\b/, 'Gương chiếu hậu'],
  [/\bgasket\b/, 'Ron'],
  [/\bbearing\b/, 'Bạc đạn'],
  [/\bsensor\b/, 'Cảm biến'],
  [/\bswitch\b/, 'Công tắc'],
  [/\brelay\b/, 'Rơ le'],
  [/\bfuse\b/, 'Cầu chì'],
  [/\bbattery\b/, 'Ắc quy'],
  [/\bhorn\b/, 'Còi'],
];
function ruleKeyword(nameEn) {
  const lo = ' ' + nameEn.toLowerCase() + ' ';
  for (const [re, vi] of KW) {
    if (re.test(lo)) {
      let out = vi;
      const front = /\bfront\b/.test(lo), rear = /\brear\b/.test(lo);
      const lh = /\b(lh|left)\b/.test(lo), rh = /\b(rh|right)\b/.test(lo);
      if (front && !/trước/.test(out)) out += ' trước';
      else if (rear && !/sau/.test(out)) out += ' sau';
      if (lh) out += ' trái'; else if (rh) out += ' phải';
      return out;
    }
  }
  return null;
}

/**
 * Dịch 1 tên. Thứ tự ưu tiên: mã OEM → exact EN → rule phanh → rule từ khóa.
 * @returns {string|null}
 */
export function translateOffline(nameEn, oemCode) {
  if (oemCode) {
    const hit = CODE_MAP.get(normCode(oemCode));
    if (hit) return hit;
  }
  if (!nameEn || !String(nameEn).trim()) return null;
  const key = String(nameEn).trim().toUpperCase();
  if (VIET[key]) return VIET[key];
  return ruleBrake(nameEn) || ruleKeyword(nameEn);
}

export const _stats = { codeMapSize: CODE_MAP.size, exactSize: Object.keys(VIET).length, kwRules: KW.length };
