/**
 * dich_v2.mjs — DỊCH TÊN PHỤ TÙNG OFFLINE, THEO DANH TỪ CHÍNH
 *
 * Khác translate_offline.mjs ở chỗ: bản cũ quét từ khóa bất kỳ vị trí nào nên
 * hay bắt trúng BỔ NGỮ rồi bỏ mất danh từ chính —
 *   "BRACKET SUB-ASSY FUEL TANK MOUNTING REAR RH" → "Bình xăng sau phải"  (SAI)
 * Bản này bám cấu trúc thật của tên phụ tùng: DANH_TỪ đứng đầu, bổ ngữ theo sau.
 *   → "Giá bắt bình xăng sau phải"  (ĐÚNG)
 *
 * Không dịch được thì trả null — KHÔNG đoán bừa. Thà để tiếng Anh còn hơn sai nghĩa.
 *
 * dichV2(nameEn) → string | null
 */

// ─── 1) DANH TỪ CHÍNH (từ đầu tên) ────────────────────────────────
// Phủ ~74% tên chưa dịch. Thuật ngữ theo cách gọi của thợ VN.
const DAU = {
  COVER:'Nắp', BRACKET:'Giá bắt', PANEL:'Tấm ốp', BOLT:'Bu lông', HOSE:'Ống mềm',
  MOULDING:'Nẹp', SCREW:'Vít', PLATE:'Tấm', CLIP:'Kẹp', WIRING:'Bộ dây điện',
  TUBE:'Ống', PAD:'Đệm', CUSHION:'Đệm', PIPE:'Ống', SPRING:'Lò xo', CAP:'Nắp',
  SEAL:'Phớt', TRIM:'Ốp trang trí', NUT:'Đai ốc', CARPET:'Thảm', BACK:'Lưng ghế',
  VALVE:'Van', SEAT:'Ghế', HANDLE:'Tay nắm', HARNESS:'Bộ dây điện', CABLE:'Dây cáp',
  BELT:'Dây đai', REINFORCEMENT:'Thanh gia cường', ARMREST:'Bệ tì tay',
  PROTECTOR:'Tấm bảo vệ', WASHER:'Long đen', RETAINER:'Vòng hãm', GEAR:'Bánh răng',
  DECAL:'Tem dán', LABEL:'Nhãn', PLUG:'Nút bịt', BEZEL:'Viền', GARNISH:'Ốp trang trí',
  SHIELD:'Tấm chắn', SUPPORT:'Giá đỡ', SHAFT:'Trục', PIN:'Chốt', LAMP:'Đèn',
  FRAME:'Khung', RAIL:'Thanh ray', HOUSING:'Vỏ', ROD:'Thanh', NAMEPLATE:'Biển tên',
  GLASS:'Kính', HOLDER:'Giá giữ', WIRE:'Dây điện', HINGE:'Bản lề', MEMBER:'Thanh dầm',
  INSULATOR:'Tấm cách âm', GRILLE:'Lưới', GROMMET:'Gioăng lỗ', GUIDE:'Thanh dẫn hướng',
  EXTENSION:'Đoạn nối', STAY:'Thanh chống', MODULE:'Mô đun', ARM:'Cần', STOPPER:'Chốt chặn',
  CASE:'Vỏ hộp', LINK:'Thanh nối', HOOK:'Móc', PILLAR:'Trụ', DUCT:'Ống dẫn gió',
  KNOB:'Núm', LEVER:'Cần gạt', CLAMP:'Kẹp ống', SPACER:'Vòng đệm', RING:'Vòng',
  WELT:'Viền', BAND:'Đai', BAR:'Thanh', BASE:'Đế', BEARING:'Bạc đạn', BLOCK:'Khối',
  BOARD:'Tấm', BODY:'Thân', BOOT:'Chụp cao su', BOX:'Hộp', BUCKLE:'Khóa dây an toàn',
  BULB:'Bóng đèn', BUMPER:'Cản', BUSH:'Bạc lót', BUTTON:'Nút bấm', CAMSHAFT:'Trục cam',
  CAP_SEAL:'Nắp bịt', CARRIER:'Giá đỡ', CHAIN:'Xích', CHANNEL:'Rãnh dẫn',
  CLUSTER:'Cụm đồng hồ', COIL:'Cuộn dây', COLUMN:'Trục lái', COMPRESSOR:'Lốc điều hòa',
  CONDENSER:'Giàn nóng', CONNECTOR:'Giắc nối', CONSOLE:'Bệ giữa', CONTROL:'Bộ điều khiển',
  CORD:'Dây', CORE:'Lõi', COUPLING:'Khớp nối', CRANKSHAFT:'Trục khuỷu', CUP:'Cốc',
  CYLINDER:'Xy lanh', DAMPER:'Giảm chấn', DEFLECTOR:'Tấm hướng dòng', DIAPHRAGM:'Màng',
  DISC:'Đĩa', DOOR:'Cửa', DRUM:'Tăng bua', ELEMENT:'Lõi lọc', EMBLEM:'Logo',
  ENGINE:'Động cơ', ESCUTCHEON:'Ốp che', EVAPORATOR:'Giàn lạnh', FAN:'Quạt',
  FASTENER:'Chốt cài', FENDER:'Chắn bùn', FILLER:'Ống đổ', FILTER:'Lọc', FITTING:'Đầu nối',
  FLANGE:'Mặt bích', FLOOR:'Sàn', FORK:'Càng gạt', GASKET:'Ron', GAUGE:'Đồng hồ đo',
  GRIP:'Tay nắm', GUSSET:'Tấm gia cường', HEADER:'Thanh ngang', HEADLINING:'Trần xe',
  HEATER:'Bộ sưởi', HORN:'Còi', HUB:'Moay ơ', INJECTOR:'Kim phun', INLET:'Cổ hút',
  INSERT:'Miếng chèn', JOINT:'Khớp nối', KEY:'Chìa khóa', KIT:'Bộ', LATCH:'Chốt khóa',
  LENS:'Mặt kính đèn', LID:'Nắp', LINER:'Lớp lót', LINING:'Lớp lót', LOCK:'Khóa',
  MAT:'Thảm', METER:'Đồng hồ', MIRROR:'Gương', MOTOR:'Mô tơ', MOUNT:'Chân đỡ',
  MOUNTING:'Chân đỡ', NOZZLE:'Vòi phun', ORNAMENT:'Chi tiết trang trí', OUTLET:'Cửa ra',
  PACKING:'Gioăng', PISTON:'Piston', PIVOT:'Trục xoay', POCKET:'Hộc đựng', PULLEY:'Puly',
  PUMP:'Bơm', RACK:'Thanh răng', RADIATOR:'Két nước', REGULATOR:'Bộ điều chỉnh',
  RELAY:'Rơ le', RESERVOIR:'Bình chứa', RESISTOR:'Điện trở', RETURN:'Đường hồi',
  RIVET:'Đinh tán', ROLLER:'Con lăn', ROOF:'Nóc xe', ROTOR:'Rô to', RUBBER:'Cao su',
  SASH:'Khung kính', SCUFF:'Ốp bậc cửa', SENSOR:'Cảm biến', SHACKLE:'Quang nhíp',
  SHEET:'Tấm', SHOCK:'Giảm xóc', SHOE:'Guốc phanh', SILENCER:'Bình giảm thanh',
  SLIDER:'Con trượt', SOCKET:'Đui đèn', SOLENOID:'Van điện từ', SPEAKER:'Loa',
  SPINDLE:'Trục quay', SPOILER:'Cánh gió', SPROCKET:'Nhông xích', STABILIZER:'Thanh cân bằng',
  STRAINER:'Lưới lọc', STRAP:'Dây đai', STRIKER:'Chốt hãm cửa', STRUT:'Giảm xóc',
  STUD:'Vít cấy', SWITCH:'Công tắc', TANK:'Bình', TAPE:'Băng dính', TENSIONER:'Bộ căng đai',
  TERMINAL:'Đầu cực', THERMOSTAT:'Van hằng nhiệt', THRUST:'Bạc chặn', TIE:'Thanh giằng',
  TRACK:'Ray trượt', TRAY:'Khay', VISOR:'Tấm che nắng', WEATHERSTRIP:'Gioăng',
  WELL:'Hốc', WHEEL:'Bánh xe', WINDOW:'Cửa kính', WIPER:'Gạt mưa', YOKE:'Càng',
};

// ─── 2) BỔ NGỮ — cụm nhận ra trong phần còn lại của tên ────────────
// Xếp theo thứ tự ghép ra tiếng Việt: bộ phận → vị trí → bên.
const BO_NGU = [
  [/\bfuel tank\b/, 'bình xăng'], [/\bair cleaner\b/, 'lọc gió'],
  [/\bcylinder head\b/, 'nắp quy lát'], [/\bcylinder block\b/, 'thân máy'],
  [/\bcrankshaft\b/, 'trục khuỷu'], [/\bcamshaft\b/, 'trục cam'],
  [/\btiming (belt|chain)\b/, 'cam'], [/\bwater pump\b/, 'bơm nước'],
  [/\boil pump\b/, 'bơm dầu'], [/\bfuel pump\b/, 'bơm xăng'],
  [/\boil pan\b/, 'các te dầu'], [/\bexhaust\b/, 'xả'], [/\bintake\b/, 'hút'],
  [/\bradiator\b/, 'két nước'], [/\bengine\b/, 'động cơ'],
  [/\btransmission\b|\bgearbox\b/, 'hộp số'], [/\bclutch\b/, 'ly hợp'],
  [/\bdifferential\b/, 'vi sai'], [/\bpropeller shaft\b/, 'láp dọc'],
  [/\bdrive shaft\b/, 'láp'], [/\bsteering\b/, 'lái'], [/\bbrake\b/, 'phanh'],
  [/\bsuspension\b/, 'treo'], [/\bshock absorber\b/, 'giảm xóc'],
  [/\bwindshield\b|\bwind shield\b/, 'kính chắn gió'], [/\bwindow\b/, 'cửa kính'],
  [/\bback ?door\b|\btail ?gate\b/, 'cửa hậu'], [/\bslide door\b/, 'cửa trượt'],
  [/\bdoor\b/, 'cửa'], [/\bhood\b/, 'capô'], [/\broof\b/, 'nóc'],
  [/\bfender\b/, 'chắn bùn'], [/\bbumper\b/, 'cản'], [/\bquarter\b/, 'hông xe'],
  [/\binstrument panel\b/, 'táp lô'], [/\bconsole\b/, 'bệ giữa'],
  [/\bglove\b/, 'hộc táp lô'], [/\bseatback\b|\bseat back\b/, 'lưng ghế'],
  [/\bseat cushion\b/, 'đệm ghế'], [/\bseat belt\b/, 'dây an toàn'],
  [/\bseat\b/, 'ghế'], [/\bheadlamp\b|\bhead lamp\b/, 'đèn pha'],
  [/\btail ?lamp\b|\brear combination\b/, 'đèn hậu'],
  [/\bturn signal\b/, 'đèn xi nhan'], [/\bfog lamp\b/, 'đèn sương mù'],
  [/\broom lamp\b/, 'đèn trần'], [/\blamp\b/, 'đèn'], [/\bmirror\b/, 'gương'],
  [/\bwiper\b/, 'gạt mưa'], [/\bheater\b/, 'sưởi'],
  [/\bair ?con(ditioner|ditioning)?\b|\ba\/c\b/, 'điều hòa'],
  [/\bbattery\b/, 'ắc quy'], [/\balternator\b/, 'máy phát'],
  [/\bstarter\b/, 'máy đề'], [/\bmuffler\b/, 'bình giảm thanh'],
  [/\bcatalytic\b/, 'bầu xúc tác'], [/\bwheel\b/, 'bánh xe'],
  [/\bspare tire\b|\bspare wheel\b/, 'lốp dự phòng'], [/\bfloor\b/, 'sàn'],
  [/\bdeck\b/, 'khoang sau'], [/\bpillar\b/, 'trụ'], [/\bcowl\b/, 'khoang máy'],
  [/\bapron\b/, 'tai xe'], [/\bside member\b/, 'dầm dọc'],
  [/\bcross ?member\b/, 'dầm ngang'], [/\bhinge\b/, 'bản lề'],
  [/\bantenna\b/, 'ăng ten'], [/\bhorn\b/, 'còi'], [/\bspeaker\b/, 'loa'],
  [/\bfuse\b/, 'cầu chì'], [/\brelay\b/, 'rơ le'], [/\bsensor\b/, 'cảm biến'],
  [/\bswitch\b/, 'công tắc'], [/\becu\b|\becm\b/, 'hộp điều khiển'],
];

const VITRI = [
  [/\bfront\b|\bfr\b/, 'trước'], [/\brear\b|\brr\b/, 'sau'],
  [/\bupper\b/, 'trên'], [/\blower\b/, 'dưới'],
  [/\binner\b/, 'trong'], [/\bouter\b/, 'ngoài'],
  [/\bcent(er|re)\b|\bctr\b/, 'giữa'],
];

function ben(lo) {
  // "LH"/"L," ở tên phụ tùng luôn là trái; tránh bắt nhầm chữ "l" lẻ trong từ khác
  if (/\blh\b|\bleft\b|\(l\)|^l[,\s]/.test(lo)) return 'trái';
  if (/\brh\b|\bright\b|\(r\)|^r[,\s]/.test(lo)) return 'phải';
  return null;
}

const SO = /\bno\.?\s*(\d+)\b/;

/**
 * @param {string} nameEn
 * @returns {string|null} tên tiếng Việt, hoặc null nếu không nhận ra danh từ chính
 */
export function dichV2(nameEn) {
  if (!nameEn) return null;
  const s = String(nameEn).trim();
  if (!s) return null;

  const dau = /^([A-Za-z]+)/.exec(s);
  if (!dau) return null;                       // tên bắt đầu bằng số/ký tự lạ
  const goc = DAU[dau[1].toUpperCase()];
  if (!goc) return null;                       // không biết danh từ chính → bỏ, không đoán

  const lo = ' ' + s.toLowerCase() + ' ';
  const phan = [goc];

  // bổ ngữ bộ phận: lấy CỤM ĐẦU TIÊN khớp. Bảng xếp từ cụ thể đến chung
  // ("seat cushion" đứng trước "seat") nên cụm đầu luôn là cụm sát nghĩa nhất.
  let bo = null;
  for (const [re, vi] of BO_NGU) if (re.test(lo)) { bo = vi; break; }
  if (bo) phan.push(bo);

  // vị trí: bỏ nếu bổ ngữ đã hàm ý sẵn — "đèn hậu"/"cửa hậu" đã là sau rồi
  const HAM_Y = { 'sau': /hậu|sau/, 'trước': /trước/, 'giữa': /giữa/ };
  for (const [re, vi] of VITRI) {
    if (re.test(lo)) {
      const h = HAM_Y[vi];
      if (!bo || !(h ? h.test(bo) : bo.includes(vi))) phan.push(vi);
      break;
    }
  }

  const b = ben(lo);
  if (b) phan.push(b);

  const so = SO.exec(lo);
  if (so) phan.push('số ' + so[1]);

  return phan.join(' ');
}

export const _thongKe = { dauSize: Object.keys(DAU).length, boNgu: BO_NGU.length };
