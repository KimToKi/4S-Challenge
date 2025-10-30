const sqlite3 = require('sqlite3').verbose();
const axios = require('axios');
const db = new sqlite3.Database('./db.sqlite');
require('dotenv').config();

const configuredTz = process.env.SCORE_TZ || process.env.APP_TZ || process.env.TZ || 'Asia/Bangkok';
let activeTimeZone = configuredTz;
let cachedDateFormatter;

function getZonedDateParts(date = new Date()) {
  if (!cachedDateFormatter) {
    try {
      cachedDateFormatter = new Intl.DateTimeFormat('en-CA', {
        timeZone: activeTimeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
      });
    } catch (err) {
      activeTimeZone = 'UTC';
      cachedDateFormatter = new Intl.DateTimeFormat('en-CA', {
        timeZone: activeTimeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
      });
      console.warn(`Invalid timezone '${configuredTz}', falling back to UTC`);
    }
  }
  const parts = cachedDateFormatter.formatToParts(date);
  const map = {};
  for (const part of parts) {
    if (part.type !== 'literal') {
      map[part.type] = part.value;
    }
  }
  return map;
}

// ---------- Message helpers (Thai, cute & motivational) ----------
function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}
function fmt(str, vars) {
  return str.replace(/\{(\w+)\}/g, (_, k) => (vars?.[k] ?? ''));
}

// ensure each pool cycles through all messages before repeating
const poolState = {};
function shuffledIndexes(n) {
  const a = [...Array(n).keys()];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function pickMsg(poolName, vars = {}) {
  const pool = cleanMsgPools[poolName] || [];
  if (!pool.length) return '';
  if (!poolState[poolName] || poolState[poolName].length === 0) {
    poolState[poolName] = shuffledIndexes(pool.length);
  }
  const idx = poolState[poolName].pop();
  return fmt(pool[idx], vars);
}

// Clean Thai message pools
const cleanMsgPools = {
  inspire: [
    'วันนี้ก็ทำได้ดีมากๆ เลยนะ',
    'ค่อยๆ ก้าวไป เดี๋ยวก็ถึง',
    'เติมพลังบวกไว้ แล้วลงมือทำต่อ',
    'พักหายใจนิดนึง แล้วไปต่อกัน',
    'เชื่อในตัวเองนะ เก่งมาก!'
  ],
  link_need_photo: [
    'ขอรูปหลักฐานสำหรับ /link_30d วันนี้ด้วยนะ\n• {quote}',
    'ขอบคุณล่วงหน้า! ส่งรูปยืนยัน /link_30d หน่อยจ้า\n• {quote}',
    'ช่วยส่งรูปเช็กอินวันนี้ให้หน่อยนะ /link_30d\n• {quote}'
  ],
  link_received: [
    'รับรูปแล้วนะ บันทึก /link_30d สำเร็จจ้า 🎉\n• {quote}',
    'ได้รูปยืนยันแล้ว! นับเป็นเช็กอินวันนี้นะ ✅\n• {quote}',
    'เยี่ยมมาก! รูปวันนี้ถูกบันทึกเรียบร้อย ✅\n• {quote}'
  ],
  connection: [
    'เยี่ยมมาก {displayName}! เชื่อมต่อเพิ่ม {n} ครั้งแล้วนะ\nไปต่อเนื่องเลย\n+{pts} คะแนน',
    '{displayName} เก็บคอนเนคชั่นเพิ่ม {n} ครั้ง\nรักษาโมเมนตัมไว้!\n+{pts} คะแนน',
    'คอนเนคชั่นมาแล้ว {n} ครั้ง ดีมาก\nไปต่อกันนะ\n+{pts} คะแนน',
    'เพิ่มคอนเนคชั่นครบ {n} ครั้งวันนี้\nลุยต่อได้เลย\n+{pts} คะแนน',
    '{displayName} ทำได้เยี่ยม เพิ่มอีก {n} ครั้ง\nสุดยอดมาก\n+{pts} คะแนน',
    'ต่อเนื่องสุดๆ {n} ครั้งแล้ว\nเก็บแต้มต่อไป!\n+{pts} คะแนน'
  ],
  multiplier: [
    '{displayName} ทำ {label} ครบครั้งที่ {count} แล้ว!\nรักษาความสม่ำเสมอไว้เลย\n+{pts} คะแนน',
    'ความสม่ำเสมอมาแล้ว: {label} #{count}\nสุดยอดมาก\n+{pts} คะแนน',
    '{label} เดินหน้าอย่างต่อเนื่อง (#{count})\nดีมากๆ เลย\n+{pts} คะแนน',
    '{label} #{count} โดย {displayName}\nไปต่ออีกนิด!\n+{pts} คะแนน',
    'สะสม {label} ครบ #{count}\nเก่งมาก\n+{pts} คะแนน',
    'ติดสปีดความสม่ำเสมอ ({label} #{count})\nเยี่ยมไปเลย\n+{pts} คะแนน'
  ],
  bm_product: [
    'ได้รับรูป BM แล้ว ขอบคุณมาก!\n+{pts} คะแนน',
    'BM วันนี้สุดปัง {displayName} ✨\n+{pts} คะแนน',
    'บันทึกหลักฐาน BM เรียบร้อย\n+{pts} คะแนน'
  ],
  pack3: [
    'จัด 3 Pack เรียบร้อย!\n+{pts} คะแนน',
    'Pack 3 มาแล้ว เดินเครื่องต่อเลย\n+{pts} คะแนน',
    'เยี่ยมมาก จัดครบ 3 Pack แล้ว\n+{pts} คะแนน'
  ],
  old_member: [
    'ติดตามสมาชิกเดิมเรียบร้อย เยี่ยมมาก\n+{pts} คะแนน',
    'ดูแลลูกทีมเก่าได้ดีมาก\n+{pts} คะแนน',
    'โฟกัสสมาชิกเดิมสม่ำเสมอ ดีมากๆ\n+{pts} คะแนน'
  ],
  sop: [
    'ทำ SOP ให้ member แล้ว เยี่ยมมาก\n+{pts} คะแนน',
    'SOP สำเร็จ จัดไปอีกขั้น\n+{pts} คะแนน',
    'SOP เรียบร้อย ดูแลทีมได้ดีมาก\n+{pts} คะแนน'
  ],
  use_product: [
    'ส่งรายงานการใช้สินค้าแล้ว ขอบคุณนะ\n+{pts} คะแนน',
    'เก็บการใช้สินค้าวันนี้เรียบร้อย\n+{pts} คะแนน',
    'รายงานใช้สินค้าสำเร็จ เยี่ยมมาก\n+{pts} คะแนน'
  ],
  plan_success: [
    'อัปเดตแผนสำเร็จ ดีมาก\n+{pts} คะแนน',
    'แผนคืบหน้าไปอีกก้าว เยี่ยมเลย\n+{pts} คะแนน',
    'แผนเดินหน้าตามเป้า\n+{pts} คะแนน'
  ],
  plan_fail: [
    'ยังอัปเดตแผนไม่ครบตามกำหนด\n-{abs} คะแนน',
    'พลาดอัปเดตรอบนี้นะ\n-{abs} คะแนน',
    'ยังไม่ถึงเกณฑ์ที่กำหนด\n-{abs} คะแนน'
  ],
  link_fail: [
    'Link 30 วันยังไม่ครบตามกำหนด\n-{abs} คะแนน',
    'ยังทำ Link ไม่ครบ\n-{abs} คะแนน',
    'รอบนี้ยังไม่ถึงเกณฑ์นะ\n-{abs} คะแนน'
  ],
  link_none: [
    'วันนี้ยังไม่มี Link 30 วัน\n+{pts} คะแนน',
    'ถ้ายังไม่สะดวก ส่งพรุ่งนี้ได้จ้า\n+{pts} คะแนน',
    'ยังไม่ส่ง Link วันนี้\n+{pts} คะแนน'
  ],
  book_success: [
    'จองสำเร็จ! เยี่ยมมาก\n+{pts} คะแนน',
    'ได้คิวแล้วนะ\n+{pts} คะแนน',
    'ปิดงานเรียบร้อย สุดยอด\n+{pts} คะแนน',
    'ยืนยันนัดหมายสำเร็จ\n+{pts} คะแนน'
  ],
  book_fail: [
    'ยังจองไม่สำเร็จนะ ไว้ลองใหม่ได้\n-{abs} คะแนน',
    'พลาดการจองรอบนี้\n-{abs} คะแนน',
    'ยังไม่สำเร็จ ลองอีกครั้งนะ\n-{abs} คะแนน'
  ],
  unknown: [
    'ยังไม่เข้าใจคำสั่งนี้ ลอง /help เพื่อดูรายการ',
    'ถ้าสงสัย ลองพิมพ์ /help ได้เลย',
    'พิมพ์ /help เพื่อดูคำสั่งทั้งหมด',
    'ต้องการความช่วยเหลือใช่ไหม? ใช้ /help ได้',
    'คำสั่งนี้ยังไม่รองรับ ลอง /help'
  ]
};

// Message pools per action
const msgPools = {
  inspire: [
    'เชื่อเสมอว่าวันนี้เราทำได้ดีกว่าเมื่อวาน',
    'ความพยายามไม่เคยทรยศใคร',
    'ก้าวเล็กๆ วันนี้ คือความสำเร็จวันพรุ่งนี้',
    'โฟกัสที่การเติบโต มากกว่าความสมบูรณ์แบบ',
    'ลงมือทำให้สม่ำเสมอ แล้วผลลัพธ์จะตามมา'
  ],
  link_need_photo: [
    '📷 ส่งรูปหลักฐานด้วยนะ เพื่อให้คำสั่ง /link_30d ทำงาน\n— {quote}',
    '✨ เกือบเสร็จแล้ว! เหลืออัปโหลดรูปหลักฐานอีกนิดเดียว\n— {quote}',
    '🧾 ขอรูปยืนยันหน่อยนะ แล้วจะบันทึกให้ทันที\n— {quote}'
  ],
  link_received: [
    '✅ ได้รับรูปแล้ว บันทึก /link_30d เรียบร้อย ✨\n— {quote}',
    '📸 รูปหลักฐานชัดเจนมาก! ลงบันทึกให้แล้วนะ ✅\n— {quote}',
    'เยี่ยมมาก! รับรูปและบันทึกวันนี้เรียบร้อยแล้ว ✨\n— {quote}'
  ],
  connection: [
    '🤝 {displayName} ได้รู้จักเพื่อนใหม่ {n} คน!\n🌈 ทุกการเชื่อมต่อคือประตูสู่โอกาส!\n🎁 +{pts} คะแนน',
    '🧲 สร้างคอนเนคชันเพิ่มอีก {n} คน เก่งมาก {displayName}!\n🚀 ทีมกำลังเติบโตไปกับคุณ!\n🎁 +{pts} คะแนน',
    '🌟 วันนี้มีเพื่อนใหม่ {n} คนเข้าแก๊ง!\n{displayName} คือพลังงานบวกของทีมเลย!\n🎁 +{pts} คะแนน',
    '🎈 เชื่อมต่อสำเร็จ {n} คน\nมือใหม่ก็ทำได้ มืออาชีพอย่างคุณยิ่งปัง!\n🎁 +{pts} คะแนน',
    '🪄 คอนเนคชันเพิ่ม {n} คน แบบเนียนๆ!\n✨ สายสัมพันธ์คือซุปเปอร์พาวเวอร์\n🎁 +{pts} คะแนน',
    '📣 เครือข่ายขยายอีก {n} คน!\n🤝 ทีมของเรากำลังอบอุ่นขึ้นทุกวัน\n🎁 +{pts} คะแนน',
    '🌐 โยงใยความสัมพันธ์ {n} จุด!\n⚡ โมเมนตัมมาแล้ว ไปต่อเลย!\n🎁 +{pts} คะแนน',
    '💬 ทักทายโลกอีก {n} ครั้ง\n💖 ความกล้าเล็กๆ นำไปสู่เรื่องใหญ่\n🎁 +{pts} คะแนน'
  ],
  multiplier: [
    '🎉 {displayName} ทำ {label} ครั้งที่ {count}!\n🔥 ความกล้าของคุณคือประกายให้ทั้งทีม!\n🎁 +{pts} คะแนน',
    '✨ มิชชัน {label} สำเร็จครั้งที่ {count}\n{displayName} กำลังขึ้นสู่โหมดเทพ!\n🎁 +{pts} คะแนน',
    '🏁 เช็กลิสต์ {label} ผ่านอีกด่าน! (#{count})\n👏 โมเมนตัมมาแล้ว อย่าหยุด!\n🎁 +{pts} คะแนน',
    '🌈 {label} ครั้งที่ {count} ของ {displayName}\nไฟแรงแบบนี้ ทีมรักเลย!\n🎁 +{pts} คะแนน',
    '🚀 {label} พุ่งต่อไม่รอแล้วนะ #{count}!\n🧡 ทีมฮึดตามทันที\n🎁 +{pts} คะแนน',
    '🔁 ทำได้ต่อเนื่องสุดๆ ({label} #{count})\n🧩 วินัยสร้างผลลัพธ์จริง\n🎁 +{pts} คะแนน',
    '💥 ปิดภารกิจ {label} อีกครั้ง!\n🌟 ความคงเส้นคงวาน่าชื่นชม\n🎁 +{pts} คะแนน',
    '🧭 {label} #{count} ตรงเป้าเป๊ะ\n🙌 เก็บเล็กผสมน้อย คะแนนพุ่งชัวร์\n🎁 +{pts} คะแนน'
  ],
  bm_product: [
    '📦 เล่าเคส BM พร้อมภาพ เป๊ะมาก!\n💡 อินไซต์ดี ทีมได้ประโยชน์สุดๆ\n🎁 +{pts} คะแนน',
    '🧩 BM มาแล้วหนึ่งช็อต!\n{displayName} ใส่ใจดีเทล น่ารักที่สุด\n🎁 +{pts} คะแนน',
    '🖼️ เคส BM ชัดเจน มีหลักฐานครบ\n🧠 เพื่อนๆ ได้เรียนรู้ไปด้วยกัน\n🎁 +{pts} คะแนน',
    '🔎 แชร์ BM แบบ Insightful!\n👏 คุณคือคลังความรู้ประจำทีม\n🎁 +{pts} คะแนน'
  ],
  pack3: [
    '🎧 คนใหม่ฟังจบครบ 3 Pack!\n💪 พื้นฐานแน่น อนาคตสดใส\n🎁 +{pts} คะแนน',
    '📚 3 Pack ครบ!\n{displayName} พาเพื่อนใหม่ตั้งต้นอย่างสวยงาม\n🎁 +{pts} คะแนน',
    '🧠 ปูพื้นสำเร็จ 3 แพ็ก\n🌱 เริ่มต้นดี ไปได้ไกลแน่\n🎁 +{pts} คะแนน',
    '🥳 โหดมาก 3 Pack ปิดงาน!\n✨ ความสม่ำเสมอคือคีย์ของคุณ\n🎁 +{pts} คะแนน'
  ],
  old_member: [
    '🛍️ ลูกค้าเก่าซื้อของแล้วจ้า!\n🤝 ความสัมพันธ์ระยะยาวคือหัวใจของการเติบโต\n🎁 +{pts} คะแนน',
    '🔄 ลูกค้าเก่ากลับมาอีกครั้ง ดีมาก!\n🌟 ความไว้ใจนี้คุณสร้างเองเลย\n🎁 +{pts} คะแนน',
    '💎 รีพีตคือของจริง!\n🏆 ความใส่ใจของ {displayName} ชนะใจลูกค้า\n🎁 +{pts} คะแนน',
    '📦 ออเดอร์จากลูกค้าเก่าเข้าอีกแล้ว\n💖 ดูแลดี เขาก็รักเรา\n🎁 +{pts} คะแนน'
  ],
  sop: [
    '🧪 ซื้อ SOP หรือ member ใหม่ซื้อ SOP!\n🌱 วางฐานสุขภาพดีไปด้วยกัน\n🎁 +{pts} คะแนน',
    '🍀 SOP อีกหนึ่งขั้นสู่ความปัง!\n{displayName} ดูแลตัวเองและทีมสุดๆ\n🎁 +{pts} คะแนน',
    '🧬 เติม SOP เหมือนเติมพลัง\n⚡ ความสดใสมาเต็ม\n🎁 +{pts} คะแนน',
    '🌿 SOP เข้าเส้นชัยอีกชิ้น\n💚 สุขภาพดีคือทุนระยะยาว\n🎁 +{pts} คะแนน'
  ],
  use_product: [
    '📸 ใช้สินค้าแล้วถ่ายแชร์ให้ทีมเห็น!\n📈 ตัวอย่างที่ดีมีค่ามากสุด\n🎁 +{pts} คะแนน',
    '🧃 ใช้จริง รีวิวจริง น่ารัก!\n🔥 อินสไปร์เพื่อนๆ สุดหัวใจ\n🎁 +{pts} คะแนน',
    '🪞 โพสต์ใช้สินค้าจริง ชัดเจน!\n✨ ของดีต้องแชร์ต่อ\n🎁 +{pts} คะแนน',
    '🎥 แคปภาพ/คลิปการใช้จริง น่ารักมาก\n🚀 เพื่อนๆ กำลังได้แรงบันดาลใจ\n🎁 +{pts} คะแนน'
  ],
  follow_old: [
    '📞 ติดตามคนเก่าสำเร็จ!\n🧠 ความใส่ใจของคุณคือหัวใจของการเติบโต\n🎁 +{pts} คะแนน',
    '🔔 ตามงานลูกค้าเก่าแบบอบอุ่น~\n👏 ความสม่ำเสมอพาคะแนนมาแล้ว\n🎁 +{pts} คะแนน',
    '🧭 ดูแลฐานเดิมดีมาก\n🤝 ความสัมพันธ์ยั่งยืน สร้างยอดต่อเนื่อง\n🎁 +{pts} คะแนน',
    '🪴 รดน้ำต้นไม้เก่าให้เขียวสดอีกครั้ง\n🌤️ น่ารักสุดๆ\n🎁 +{pts} คะแนน'
  ],
  follow_new: [
    '📞 ติดตามคนใหม่สำเร็จ!\n🌟 ประทับใจแรกดี มีชัยไปกว่าครึ่ง\n🎁 +{pts} คะแนน',
    '🎯 โฟกัสดี คนใหม่ไม่หลุดมือ!\n🚀 สปีดแบบนี้ ปังต่อเนื่องแน่\n🎁 +{pts} คะแนน',
    '🌈 วางรากฐานลูกค้าใหม่อบอุ่นมาก\n💖 เขาต้องชอบคุณแน่เลย\n🎁 +{pts} คะแนน',
    '🛎️ ตามทันใจ ไม่ให้หายไปจากเรดาร์\n⚡ เก่งมาก!\n🎁 +{pts} คะแนน'
  ],
  plan_success: [
    '📋 อัปเดตแผนสำเร็จ!\n🧭 คุณคือเข็มทิศของทีมในเดือนนี้\n🎁 +{pts} คะแนน',
    '🗺️ แผนชัด ก้าวต่อมั่นใจ~\n✨ ดำเนินต่อไปแบบมีโฟกัส\n🎁 +{pts} คะแนน',
    '🧱 อัปเดตทีละก้อน รากฐานแน่น\n🌟 ทำดีมาก\n🎁 +{pts} คะแนน',
    '📌 ติ๊กเช็กลิสต์เรียบร้อย!\n🚀 โฟกัสดี งานก็พุ่งดี\n🎁 +{pts} คะแนน'
  ],
  plan_fail: [
    '⚠️ เดือนนี้ไม่มีการอัปเดตแผนเลย\n😵 -{abs} คะแนนถูกหักจากความเงียบ\n⏳ อย่าปล่อยให้โอกาสหลุดมือ — เดือนหน้ากลับมาใหม่!',
    '🙈 แผนหายไปทั้งเดือน\n💔 -{abs} คะแนน แต่ไม่เป็นไร เริ่มใหม่ได้เสมอ\n🌱 ลองตั้งเตือนเล็กๆ ไว้ครั้งหน้า',
    '🕳️ ช่องว่างของแผนยังว่างอยู่\n🌧️ -{abs} คะแนน แต่เรายังเชียร์เสมอ\n🌤️ พรุ่งนี้เริ่มใหม่'
  ],
  link_success: [
    '🔗 Link 30 วันสำเร็จ!\n🌈 ระบบดูแลลูกค้าของคุณกำลังทำงาน!\n🎁 +{pts} คะแนน',
    '🧵 เก็บ connection 30 วันเรียบร้อย\n👏 วินัยดีมาก น่ารักกก\n🎁 +{pts} คะแนน',
    '📬 ติดตามครบกำหนด 30 วันเป๊ะๆ\n🧡 ใส่ใจแบบนี้ ลูกค้าประทับใจแน่\n🎁 +{pts} คะแนน',
    '🪢 ผูกสายสัมพันธ์ไว้ครบ 30 วัน\n✨ งานเนี้ยบมาก\n🎁 +{pts} คะแนน'
  ],
  link_fail: [
    '🪫 Link 30 วันสะดุดนิดหน่อย\n😿 -{abs} คะแนน แต่ไม่เป็นไร พรุ่งนี้ลองใหม่! ',
    '📉 ภารกิจ Link พลาดไป\n💪 ล้มได้ ลุกไว — เรายังเชียร์คุณอยู่!\n-{abs} คะแนน',
    '⏰ พลาดจังหวะไปนิดเดียว\n🫶 -{abs} คะแนน แต่ความพยายามยังสำคัญสุดๆ'
  ],
  link_none: [
    '⏸️ เดือนนี้ยังไม่ได้ทำ Link 30 วัน\n🧩 ศักยภาพยังรอปลดล็อก!\n🎁 +{pts} คะแนน',
    '🕊️ ยังไม่ได้เริ่ม Link 30 วัน\n🌱 เริ่มเล็กๆ วันนี้ก็ชนะตัวเองแล้ว\nคะแนน {pts}',
    '💤 Link 30 วันยังงีบอยู่\n🌞 ปลุกเบาๆ เมื่อพร้อม เรารอเชียร์!\nคะแนน {pts}'
  ],
  book_success: [
    '📚 Book สำเร็จ!\n🌟 ความรู้ใหม่คืออาวุธลับของคุณ\n🎁 +{pts} คะแนน',
    '📝 อ่าน-จด-ปัง!\n🚀 นำไปใช้จริง ทีมรอไอเดียอยู่นะ\n🎁 +{pts} คะแนน',
    '🧠 เติมสกิลใหม่เข้าคลัง\n🌟 เก่งขึ้นทุกวันจริงๆ\n🎁 +{pts} คะแนน',
    '🔖 ปิดเล่ม/บทได้อย่างงดงาม\n💡 Insight มาเพียบ\n🎁 +{pts} คะแนน'
  ],
  book_fail: [
    '😿 Book ไม่สำเร็จ\n💤 พักได้ แต่อย่าหยุดฝัน — เริ่มใหม่พรุ่งนี้!\n-{abs} คะแนน',
    '🪶 พลาดได้ ไม่เป็นไร\n🌤️ วันหน้าเราค่อยไปต่อด้วยกัน\n-{abs} คะแนน',
    '🌧️ วันนี้ยังไม่เข้าที่\n🌈 พรุ่งนี้จะสดใสกว่าเดิมแน่\n-{abs} คะแนน'
  ],
  unknown: [
    '❓ ไม่รู้จักคำสั่งนี้ ลองพิมพ์ /help เพื่อดูคำสั่งทั้งหมด',
    '🧐 คำสั่งไม่คุ้นเลยนะ ลอง /help ดูก่อนได้',
    '🤔 ฮึม… ยังไม่เข้าใจคำนี้ ลองใช้ /help เพื่อรายการคำสั่ง',
    '🧭 หาทางไม่เจอ? /help พร้อมพาไปต่อ',
    '📎 ขอคู่มือไหม? พิมพ์ /help เลยย'
  ]
};

// Ensure table for pending actions (e.g., waiting for image)
db.exec(`CREATE TABLE IF NOT EXISTS pending (
  user_id TEXT,
  command TEXT,
  date_key TEXT,
  month_key TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, command, date_key)
);`);

function localDateKey(d = new Date()) {
  const parts = getZonedDateParts(d);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function monthKey(date = new Date()) {
  const parts = getZonedDateParts(date);
  return `${parts.year}-${parts.month}`;
}

// year-week key using Monday-based week number (aligns with SQLite %W)
function weekKey(date = new Date()) {
  const parts = getZonedDateParts(date);
  const year = Number(parts.year);
  const month = Number(parts.month) - 1;
  const day = Number(parts.day);
  const d = new Date(Date.UTC(year, month, day));
  const weekday = (d.getUTCDay() + 6) % 7; // Mon=0..Sun=6
  d.setUTCDate(d.getUTCDate() - weekday + 3); // move to Thu
  const weekYear = d.getUTCFullYear();
  const jan4 = new Date(Date.UTC(weekYear, 0, 4));
  const jan4Day = (jan4.getUTCDay() + 6) % 7;
  const week1Mon = new Date(Date.UTC(weekYear, 0, 4 - jan4Day));
  const week = 1 + Math.floor((d - week1Mon) / 604800000);
  const w = String(week).padStart(2, '0');
  return `${weekYear}-W${w}`;
}

const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

function reconcileEventMonthKeys() {
  return new Promise((resolve) => {
    db.all('SELECT id, timestamp, month_key FROM events', (err, rows) => {
      if (err || !Array.isArray(rows) || rows.length === 0) return resolve();
      const updates = [];
      for (const row of rows) {
        const ts = typeof row.timestamp === 'string' ? row.timestamp.trim() : '';
        if (!ISO_TIMESTAMP_RE.test(ts)) continue;
        const dt = new Date(ts.replace(' ', 'T') + 'Z');
        if (Number.isNaN(dt.getTime())) continue;
        const mk = monthKey(dt);
        if (!mk || mk === row.month_key) continue;
        updates.push(new Promise((res) => {
          db.run('UPDATE events SET month_key = ? WHERE id = ?', [mk, row.id], (updateErr) => {
            if (updateErr) console.warn('Failed to update month_key for event', row.id, updateErr.message);
            res();
          });
        }));
      }
      Promise.all(updates).then(() => {
        if (updates.length) {
          console.log(`🗓️ Recomputed month_key for ${updates.length} legacy event(s) using ${activeTimeZone}`);
        }
        resolve();
      });
    });
  });
}

reconcileEventMonthKeys().catch((err) => {
  console.warn('Failed to reconcile month_key values:', err?.message || err);
});

function isoWeekRangeUTC(yw) {
  const m = /^([0-9]{4})-W([0-9]{2})$/.exec(yw || '');
  if (!m) return null;
  const year = parseInt(m[1], 10);
  const week = parseInt(m[2], 10);

  // Monday 00:00 local time for the given ISO week
  const jan4 = new Date(year, 0, 4);
  const jan4Day = (jan4.getDay() + 6) % 7; // Mon=0..Sun=6
  const week1Mon = new Date(year, 0, 4 - jan4Day); // Monday of week 1
  const startLocal = new Date(week1Mon);
  startLocal.setDate(week1Mon.getDate() + (week - 1) * 7);
  startLocal.setHours(0, 0, 0, 0);
  const endLocal = new Date(startLocal);
  endLocal.setDate(startLocal.getDate() + 7);

  const toSqlUtc = (dt) => new Date(dt.getTime() - dt.getTimezoneOffset() * 60000)
    .toISOString().slice(0, 19).replace('T', ' ');
  return { startUtc: toSqlUtc(startLocal), endUtc: toSqlUtc(endLocal) };
}

async function reply(replyToken, text) {
  if (!replyToken) return;
  try {
    await axios.post('https://api.line.me/v2/bot/message/reply', {
      replyToken,
      messages: [{ type: 'text', text }]
    }, {
      headers: {
        'Authorization': `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });
  } catch (err) {
    console.error('reply error', err?.response?.data || err.message);
  }
}

// Reply with extra inspiration and optional display name
async function replyWithInspire(replyToken, text, displayName) {
  const quote = pick(cleanMsgPools.inspire) || '';
  if (!quote) {
    await reply(replyToken, text);
    return;
  }
  const namePart = displayName ? `✨ ${displayName}` : '✨';
  const finalText = `${text}\n${namePart} ${quote}`;
  await reply(replyToken, finalText);
}

// Push message to a specified LINE target (group/user)
async function push(text) {
  const to = process.env.LINE_TARGET_ID || process.env.LINE_GROUP_ID || process.env.LINE_USER_ID;
  if (!to) {
    console.warn('No LINE_TARGET_ID/LINE_GROUP_ID/LINE_USER_ID set; skip push');
    return;
  }
  try {
    await axios.post('https://api.line.me/v2/bot/message/push', {
      to,
      messages: [{ type: 'text', text }]
    }, {
      headers: {
        'Authorization': `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });
  } catch (err) {
    console.error('push error', err?.response?.data || err.message);
  }
}

// Build weekly summary text (Top 10 for current month)
async function buildWeeklySummaryText() {
  const mk = monthKey();
  const top = await getTop10(mk);
  const lines = [];
  const now = new Date();
  const dstr = now.toISOString().slice(0, 10);
  lines.push(`📣 อัปเดตอันดับรายสัปดาห์ (${dstr})`);
  if (!top.length) {
    lines.push(`ยังไม่มีคะแนนในเดือน ${mk} — มาเริ่มเก็บแต้มกันนะ! ✨`);
  } else {
    lines.push(`🏆 Top 10 เดือน ${mk}`);
    top.forEach((r, i) => lines.push(`${i + 1}. ${r.display_name} — ${r.points} คะแนน`));
    lines.push('💪 สู้ๆ นะ ทีมเราไปด้วยกัน!');
  }
  return lines.join('\n');
}
function loadRule(command, subtype) {
  return new Promise((resolve) => {
    db.get(
      'SELECT points FROM score_rules WHERE command = ? COLLATE NOCASE AND subtype = ? COLLATE NOCASE',
      [command, subtype || ''],
      (err, row) => {
        if (err) return resolve(null);
        resolve(row ? row.points : null);
      }
    );
  });
}

function countUserCommandThisMonth(userId, command, mk) {
  return new Promise((resolve) => {
    db.get('SELECT COUNT(*) AS c FROM events WHERE user_id = ? AND command = ? COLLATE NOCASE AND month_key = ?', [userId, command, mk], (err, row) => {
      if (err) return resolve(0);
      resolve(row ? row.c : 0);
    });
  });
}

// Check if user already submitted /link_30d today (local date)
function hasLink30dToday(userId) {
  return new Promise((resolve) => {
    db.get(
      `SELECT COUNT(*) AS c
       FROM events
       WHERE user_id = ? AND command = '/link_30d' COLLATE NOCASE
         AND date(timestamp, 'localtime') = date('now','localtime')`,
      [userId],
      (err, row) => resolve(!err && row && row.c > 0)
    );
  });
}

// Check if user already submitted /use_product today (local date)
function hasUseProductToday(userId) {
  return new Promise((resolve) => {
    db.get(
      `SELECT COUNT(*) AS c
       FROM events
       WHERE user_id = ? AND command = '/use_product' COLLATE NOCASE
         AND date(timestamp, 'localtime') = date('now','localtime')`,
      [userId],
      (err, row) => resolve(!err && row && row.c > 0)
    );
  });
}

function setPendingLinkToday(userId, command, mk) {
  return new Promise((resolve) => {
    const dk = localDateKey();
    db.run(`INSERT OR IGNORE INTO pending (user_id, command, date_key, month_key) VALUES (?, ?, ?, ?)`,
      [userId, command, dk, mk], (err) => resolve(!err));
  });
}

function getPendingLinkToday(userId, command) {
  return new Promise((resolve) => {
    db.get(`SELECT * FROM pending WHERE user_id = ? AND command = ? AND date_key = ?`,
      [userId, command, localDateKey()], (err, row) => resolve(row || null));
  });
}

function clearPendingLinkToday(userId, command) {
  return new Promise((resolve) => {
    db.run(`DELETE FROM pending WHERE user_id = ? AND command = ? AND date_key = ?`,
      [userId, command, localDateKey()], () => resolve());
  });
}

function insertEvent(e) {
  return new Promise((resolve, reject) => {
    const stmt = db.prepare('INSERT INTO events (user_id, display_name, command, detail, points, month_key) VALUES (?, ?, ?, ?, ?, ?)');
    stmt.run([e.user_id, e.display_name, e.command, e.detail, e.points, e.month_key], function (err) {
      if (err) return reject(err);
      resolve(this.lastID);
    });
  });
}

function sumUserMonth(user_id, mk) {
  return new Promise((resolve) => {
    db.get('SELECT IFNULL(SUM(points),0) as total FROM events WHERE user_id = ? AND month_key = ?', [user_id, mk], (err, row) => {
      if (err) return resolve(0);
      resolve(row ? row.total : 0);
    });
  });
}

function getTop10(mk) {
  return new Promise((resolve) => {
    db.all(`SELECT display_name, IFNULL(SUM(points),0) as points
            FROM events WHERE month_key = ?
            GROUP BY display_name ORDER BY points DESC, display_name LIMIT 10`, [mk], (err, rows) => {
      if (err) return resolve([]);
      resolve(rows);
    });
  });
}

function getTop10All() {
  return new Promise((resolve) => {
    db.all(`SELECT display_name, IFNULL(SUM(points),0) as points
            FROM events
            GROUP BY display_name ORDER BY points DESC, display_name LIMIT 10`, [], (err, rows) => {
      if (err) return resolve([]);
      resolve(rows);
    });
  });
}

function getDistinctMonths() {
  return new Promise((resolve) => {
    db.all(`SELECT DISTINCT month_key as mk FROM events ORDER BY mk DESC`, [], (err, rows) => {
      if (err) return resolve([]);
      resolve(rows.map(r => r.mk));
    });
  });
}

function getTop10Week(yw) {
  return new Promise((resolve) => {
    const range = isoWeekRangeUTC(yw);
    if (!range) return resolve([]);
    db.all(`SELECT display_name, IFNULL(SUM(points),0) as points
            FROM events
            WHERE timestamp >= ? AND timestamp < ?
            GROUP BY display_name ORDER BY points DESC, display_name LIMIT 10`, [range.startUtc, range.endUtc], (err, rows) => {
      if (err) return resolve([]);
      resolve(rows);
    });
  });
}

function getDistinctWeeks() {
  return new Promise((resolve) => {
    db.all(`SELECT DISTINCT (strftime('%Y', timestamp) || '-W' || printf('%02d', CAST(strftime('%W', timestamp) AS INTEGER))) as wk
            FROM events ORDER BY wk DESC`, [], (err, rows) => {
      if (err) return resolve([]);
      resolve(rows.map(r => r.wk));
    });
  });
}

async function monthsHandler(req, res) {
  const months = await getDistinctMonths();
  const current = monthKey();
  const unique = Array.from(new Set([current, ...months]));
  res.json({ months: unique, current });
}

async function weeksHandler(req, res) {
  const weeks = await getDistinctWeeks();
  const current = weekKey();
  const unique = Array.from(new Set([current, ...weeks]));
  res.json({ weeks: unique, current });
}

// ---- /link_30d month-end settlement helpers ----
function daysInMonthKey(mk) {
  const [y, m] = mk.split('-').map(Number);
  if (!y || !m) return 30;
  return new Date(y, m, 0).getDate();
}

function distinctUsersWithLink30d(mk) {
  return new Promise((resolve) => {
    db.all(
      `SELECT DISTINCT user_id, display_name
       FROM events WHERE command = '/link_30d' COLLATE NOCASE AND month_key = ?`,
      [mk],
      (err, rows) => resolve(err ? [] : rows || [])
    );
  });
}

function countLink30dDays(userId, mk) {
  return new Promise((resolve) => {
    db.get(
      `SELECT COUNT(DISTINCT date(timestamp, 'localtime')) AS c
       FROM events WHERE user_id = ? AND command = '/link_30d' COLLATE NOCASE AND month_key = ?`,
      [userId, mk],
      (err, row) => resolve(err ? 0 : (row?.c || 0))
    );
  });
}

async function finalizeLink30dMonth(mk) {
  const users = await distinctUsersWithLink30d(mk);
  const dim = daysInMonthKey(mk);
  const results = [];
  for (const u of users) {
    const days = await countLink30dDays(u.user_id, mk);
    if (days <= 0) { // no entries at all -> 0 points per requirement
      results.push({ user_id: u.user_id, display_name: u.display_name, days, points: 0 });
      continue;
    }
    const missing = Math.max(0, dim - days);
    const pts = missing === 0 ? 4 : -missing;
    await insertEvent({
      user_id: u.user_id,
      display_name: u.display_name,
      command: '/link_30d_settle',
      detail: `settlement ${mk}: ${days}/${dim} days, missing ${missing}`,
      points: pts,
      month_key: mk
    });
    results.push({ user_id: u.user_id, display_name: u.display_name, days, points: pts });
  }
  return { month: mk, settled: results };
}

// ---- /book month-end settlement ----
function distinctUsersInMonth(mk) {
  return new Promise((resolve) => {
    db.all(`SELECT DISTINCT user_id, display_name FROM events WHERE month_key = ?`, [mk], (err, rows) => {
      if (err) return resolve([]);
      resolve(rows || []);
    });
  });
}

function countBookInMonth(userId, mk) {
  return new Promise((resolve) => {
    db.get(`SELECT COUNT(*) AS c FROM events WHERE user_id = ? AND command = '/book' COLLATE NOCASE AND month_key = ?`, [userId, mk], (err, row) => {
      if (err) return resolve(0);
      resolve(row ? row.c : 0);
    });
  });
}

async function finalizeBookMonth(mk) {
  const users = await distinctUsersInMonth(mk);
  const results = [];
  for (const u of users) {
    const cnt = await countBookInMonth(u.user_id, mk);
    if (cnt === 0) {
      await insertEvent({
        user_id: u.user_id,
        display_name: u.display_name,
        command: '/book_settle',
        detail: `settlement ${mk}: no /book this month`,
        points: -4,
        month_key: mk
      });
      results.push({ user_id: u.user_id, display_name: u.display_name, points: -4 });
    }
  }
  return { month: mk, settled: results };
}

// ---- /plan_update month-end settlement ----
function countPlanUpdateInMonth(userId, mk) {
  return new Promise((resolve) => {
    db.get(
      `SELECT COUNT(*) AS c FROM events WHERE user_id = ? AND command = '/plan_update' COLLATE NOCASE AND month_key = ?`,
      [userId, mk],
      (err, row) => resolve(err ? 0 : (row?.c || 0))
    );
  });
}

async function finalizePlanUpdateMonth(mk) {
  const users = await distinctUsersInMonth(mk);
  const results = [];
  for (const u of users) {
    const cnt = await countPlanUpdateInMonth(u.user_id, mk);
    if (cnt < 3) {
      await insertEvent({
        user_id: u.user_id,
        display_name: u.display_name,
        command: '/plan_update_settle',
        detail: `settlement ${mk}: plan updates ${cnt}/3`,
        points: -10,
        month_key: mk
      });
      results.push({ user_id: u.user_id, display_name: u.display_name, count: cnt, points: -10 });
    }
  }
  return { month: mk, settled: results };
}

async function top10Handler(req, res) {
  const ym = (req.query.ym || '').toLowerCase();
  const yw = (req.query.yw || '').toUpperCase();
  const scope = (req.query.scope || '').toLowerCase();
  let rows = [];
  let meta = {};

  if (scope === 'week' || yw) {
    const wk = yw || weekKey();
    rows = await getTop10Week(wk);
    meta = { scope: 'week', yw: wk };
  } else if (ym === 'all' || scope === 'all') {
    rows = await getTop10All();
    meta = { scope: 'all' };
  } else {
    const mk = /\d{4}-\d{2}/.test(ym) ? ym : monthKey();
    rows = await getTop10(mk);
    meta = { scope: 'month', ym: mk };
  }
  res.json({ meta, data: rows });
}

function calculateMultiplier(base, count) {
  return base * Math.pow(2, count);
}
async function handleEvent(evt) {
  const mk = monthKey();
  const text = (evt.message?.text || '').trim();
  const sourceType = evt.source?.type;
  const isGroupOrRoom = sourceType === 'group' || sourceType === 'room';

  // Ignore any message that is not a slash-command in all chats
  if (!text.startsWith('/')) {
    return; // silent on normal conversation everywhere
  }
  const parts = text.split(/\s+/);
  const cmd = (parts[0] || '').toLowerCase();
  const subtype = (parts[1] || '').toLowerCase();
  const detail = parts.slice(1).join(' ') || '(no-detail)';
  const userId = evt.source?.userId;

  if (cmd === '/groupid' || cmd === '/group_id') {
    if (sourceType === 'group' && evt.source?.groupId) {
      await reply(evt.replyToken, `Group ID: ${evt.source.groupId}`);
      return;
    }
    if (sourceType === 'room' && evt.source?.roomId) {
      await reply(evt.replyToken, `Room ID: ${evt.source.roomId}`);
      return;
    }
    await reply(evt.replyToken, 'คำสั่งนี้ใช้ได้เฉพาะในห้องสนทนากลุ่มเท่านั้น');
    return;
  }

  // In group/room, if userId is missing (e.g., OpenChat privacy), skip replying to avoid noise
  if (!userId) {
    if (isGroupOrRoom) return; // silent in groups
    return await reply(evt.replyToken, `ไม่สามารถตรวจสอบคะแนนได้ เพราะไม่ได้รับ userId`);
  }

  let displayName = 'คุณ';
  try {
    const profileRes = await axios.get(`https://api.line.me/v2/bot/profile/${userId}`, {
      headers: { Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` }
    });
    displayName = profileRes.data.displayName || 'คุณ';
  } catch {}
  // Normalize display name if garbled or empty
  if (!displayName || /[\uFFFD]/.test(displayName)) {
    displayName = 'คุณ';
  }

  // Local helpers for this event
  const total = async () => sumUserMonth(userId, mk);
  const respond = async (msg, pts) => {
    let composed = msg;
    const delta = Number(pts);
    if (!Number.isNaN(delta) && delta !== 0) {
      const sum = await total();
      composed = `${msg}\n💎 คะแนนสะสมรวม: ${sum} คะแนน`;
    }
    await replyWithInspire(evt.replyToken, composed, displayName);
  };

  // (deduped) getDisplayName is defined globally below

    async function _total2() {
    return await sumUserMonth(userId, mk);
  }
  async function _respond2(msg, pts) {
    const sum = await _total2();
    await replyWithInspire(evt.replyToken, `${msg}\n💎 คะแนนสะสมรวม: ${sum} คะแนน`, displayName);
  }

  // Simplified help: list commands only + Rules link (disabled; using unified help below)
  if (cmd === '/help' || cmd === '/rules' || cmd === '/rule') {
    const base = (process.env.PUBLIC_BASE_URL || process.env.PUBLIC_URL || process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');
    const rulesUrl = `${base}/rules`;
    const cleanHelp = [
      '📚 คำสั่งที่ใช้ได้ (พิมพ์ตามนี้):',
      '/begin onsite',
      '/beyond_dec',
      '/new_pride',
      '/new_member',
      '/old_member',
      '/sop',
      '/pack3',
      '/bm_product',
      '/use_product <สิ่งที่ใช้>',
      '/connection+N',
      '/old_follow_up',
      '/new_follow_up',
      '/link_30d',
      '/book',
      '/plan_update',
      '/score',
      '/rank',
      '',
      `ดูรายละเอียดกติกา: ${rulesUrl}`
    ].join('\n');
    await reply(evt.replyToken, cleanHelp);
    return;
    const lines = [
      'คำสั่งที่ใช้ได้:',
      '/begin onsite',
      '/beyond_dec',
      '/new_pride',
      '/new_member',
      '/old_member',
      '/sop',
      '/pack3',
      '/bm_product',
      '/use_product <สิ่งที่ใช้>',
      '/connection+N',
      '/old_follow_up',
      '/new_follow_up',
      '/link_30d',
      '/book',
      '/plan_update',
      '/score',
      '/rank',
      '',
      `กติกาแบบเต็ม: ${rulesUrl}`
    ];
    await reply(evt.replyToken, lines.join('\n'));
    return;
  }

  // --- Unified Help (/help, /rules, /rule) (disabled in favor of block above) ---
  if (false && (cmd === '/help' || cmd === '/rules' || cmd === '/rule')) {
    const base = (process.env.PUBLIC_BASE_URL || process.env.PUBLIC_URL || process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');
    const rulesUrl = `${base}/rules`;
    const lines = [
      '📚 คำสั่งที่ใช้ได้ (พิมพ์ตามนี้):',
      '- /begin onsite — พาคนใหม่เข้าระบบ Begin',
      '- /beyond_dec — พาคนใหม่เข้างาน Beyond (ธ.ค.)',
      '- /new_pride — เป็น New Pride/พาคนใหม่เข้าร่วม Pride',
      '- /new_member — สมาชิกใหม่สมัครและซื้อครบ 1,000 pv',
      '- /old_member — สมาชิกเก่าซื้อของเดือนนี้',
      '- /sop — เราซื้อ SOP หรือมี new member สมัครและซื้อ SOP',
      '- /pack3 — คนใหม่ฟังจบครบ 3 Pack',
      '- /bm_product — ทำ BM หรือเล่าเคสสินค้า (แนบรูป)',
      '- /use_product <สิ่งที่ใช้> — ใช้สินค้าพร้อมรีวิว วันละ 1 ครั้ง',
      '- /connection+N — รายชื่อ/เพื่อนใหม่ เช่น /connection+3',
      '- /old_follow_up — โทรติดตามคนเก่า',
      '- /new_follow_up — โทรติดตามคนใหม่',
      '- /link_30d — เช็กอิน 30 วัน พิมพ์ก่อน แล้วส่งรูป',
      '- /book — อ่านหนังสือจบ 1เล่ม',
      '- /plan_update — ส่งแผนต้นเดือน อัพเดทรายสัปดาห์',
      '- /score — คะแนนของฉัน',
      '- /rank — อันดับ Top 10',
      '',
      `📜 กติกาแบบเต็ม: ${rulesUrl}`
    ];
    await reply(evt.replyToken, lines.join('\n'));
    return;
  }
const insert = async (command, pts, msg) => {
    await insertEvent({ user_id: userId, display_name: displayName, command, detail, points: pts, month_key: mk });
    await respond(msg, pts);
  };

  if (cmd === '/score') {
    const sum = await total();
    await reply(evt.replyToken, `💎 คะแนนของ ${displayName} เดือน ${mk}\n✨ รวม ${sum} คะแนน ✨`);
    return;
  }
  if (cmd === '/rank') {
    const top = await getTop10(mk);
    if (!top.length) return await reply(evt.replyToken, 'ยังไม่มีคะแนนเดือน ' + mk);
    const base = (process.env.PUBLIC_BASE_URL || process.env.PUBLIC_URL || process.env.BASE_URL || 'http://localhost:' + (process.env.PORT || 3000)).replace(/\/$/, '');
    const lines = ['🏆 Top 3 เดือน ' + mk];
    top.slice(0, 3).forEach((r, i) => lines.push((i + 1) + '. ' + r.display_name + ' • ' + r.points + ' คะแนน'));
    lines.push('');
    lines.push('ดู TOP 10 แบบ realtime: ' + base + '/');
    await reply(evt.replyToken, lines.join('\n'));
    return;
  }
  if (cmd.startsWith('/connection+')) {
    const match = cmd.match(/\/connection\+(\d+)/);
    const pts = match ? parseInt(match[1]) : 0;
    if (pts > 0) {
      const msg = pickMsg('connection', { displayName, n: pts, pts: `+${pts}`.replace('++','+') });
      await insert('/connection', pts, msg);
    } else {
      await reply(evt.replyToken, `กรุณาระบุจำนวน เช่น /connection+3`);
    }
    return;
  }
    const multiplierCommands = {
    '/begin': { label: 'Begin Onsite', base: 1 },
    '/beyond_dec': { label: 'Beyond เดือนธันวาคม', base: 2 },
    '/new_pride': { label: 'New Pride', base: 2 },
    '/new_member': { label: 'ลูกค้าใหม่สมัคร + ซื้อของ', base: 1 }
  };

  if (multiplierCommands[cmd]) {
    const count = await countUserCommandThisMonth(userId, cmd, mk);
    const pts = calculateMultiplier(multiplierCommands[cmd].base, count);
    const msg = pickMsg('multiplier', { displayName, label: multiplierCommands[cmd].label, count: count + 1, pts: `+${pts}` });
    await insert(cmd, pts, msg);
    return;
  }

  const ruleBased = ['/pack3', '/old_member', '/sop'];
  if (ruleBased.includes(cmd)) {
    const pts = await loadRule(cmd, '') ?? 0;
    const poolKey = cmd.replace('/', '').toLowerCase();
    const mapping = { bm_product: 'bm_product', pack3: 'pack3', old_member: 'old_member', sop: 'sop', use_product: 'use_product' };
    const key = mapping[poolKey];
    const msg = pickMsg(key, { displayName, pts: `+${pts}` });
    await insert(cmd, pts, msg);
    return;
  }

  // /bm_product requires photo evidence (set pending and wait for image)
  if (cmd === '/bm_product') {
    await setPendingLinkToday(userId, '/bm_product', mk);
    await reply(evt.replyToken, 'โปรดถ่ายรูปรายงานสำหรับ /bm_product แล้วส่งรูปในแชทนี้');
    return;
  }

  // /use_product requires a short report and is limited to +1 per day
  if (cmd === '/use_product') {
    const already = await hasUseProductToday(userId);
    if (already) {
      await reply(evt.replyToken, 'วันนี้ส่ง /use_product แล้วนะ จำกัด 1 ครั้ง/วัน');
      return;
    }
    const report = (parts.slice(1).join(' ') || '').trim();
    if (!report) {
      await reply(evt.replyToken, 'กรุณาพิมพ์รายงานสั้นๆ ต่อท้าย เช่น:\n/use_product ใช้สินค้า X ตอนเช้า รู้สึกดีขึ้น');
      return;
    }
    const pts = await loadRule('/use_product', '') ?? 1;
    const msg = pickMsg('use_product', { displayName, pts: `+${pts}` });
    await insertEvent({ user_id: userId, display_name: displayName, command: '/use_product', detail: `report:${report}`, points: pts, month_key: mk });
    await respond(msg, pts);
    return;
  }

  // Group-only /book: +4 for the first two times per month
  if (cmd === '/book') {
    const used = await countUserCommandThisMonth(userId, '/book', mk);
    const pts = used < 2 ? 4 : 0;
    const msg = pts > 0
      ? pickMsg('book_success', { displayName, pts: `+${pts}` })
      : 'รับทราบการส่ง /book แล้ว (ครบโควตาประจำเดือน)';
    await insert('/book', pts, msg);
    return;
  }

  // New rule: /plan_update requires 3 submissions per month.
  // 1st=1/3 and 2nd=2/3 give status only (0 pts), 3rd=3/3 awards +4.
  if (cmd === '/plan_update') {
    const used = await countUserCommandThisMonth(userId, '/plan_update', mk);
    const next = used + 1;
    if (next < 3) {
      await insert('/plan_update', 0, `ส่งสถานะ ${next}/3 — ยังไม่คิดคะแนน`);
      return;
    }
    if (next === 3) {
      await insert('/plan_update', 4, 'ครบ 3/3 แล้ว ได้คะแนน +4');
      return;
    }
    await insert('/plan_update', 0, 'บันทึกอัปเดตเพิ่มเติม (เกิน 3/3)');
    return;
  }

  if (['/plan_update', '/book'].includes(cmd)) {
    const validSubtypes = ['success', 'fail', 'none'];
    if (!validSubtypes.includes(subtype)) {
      await reply(evt.replyToken, `กรุณาระบุรูปแบบที่ถูกต้อง เช่น /${cmd.slice(1)} success หรือ fail`);
      return;
    }
    const pts = await loadRule(cmd, subtype) ?? 0;
    let msg;
    if (cmd === '/plan_update') {
      msg = pts >= 0
        ? pickMsg('plan_success', { displayName, pts: `+${pts}` })
        : pickMsg('plan_fail', { abs: Math.abs(pts) });
    } else if (cmd === '/book') {
      msg = pts >= 0
        ? pickMsg('book_success', { displayName, pts: `+${pts}` })
        : pickMsg('book_fail', { abs: Math.abs(pts) });
    }
    await insert(cmd, pts, msg);
    return;
  }

  // Link 30D daily check-in requires image evidence
  if (cmd === '/link_30d') {
    const already = await hasLink30dToday(userId);
    if (already) {
      const quote = pick(cleanMsgPools.inspire);
      await reply(evt.replyToken, `บันทึก /link_30d วันนี้ไว้แล้วนะ ✨\n— ${quote}`);
      return;
    }
    await setPendingLinkToday(userId, '/link_30d', mk);
    const quote = pick(cleanMsgPools.inspire);
    await reply(evt.replyToken, pickMsg('link_need_photo', { quote }));
    return;
  }

  if (cmd === '/old_follow_up' || cmd === '/new_follow_up') {
    const pts = cmd === '/old_follow_up' ? 1 : 2;
    const msg = pickMsg(cmd === '/old_follow_up' ? 'follow_old' : 'follow_new', { displayName, pts: `+${pts}` });
    await insert(cmd, pts, msg);
    return;
  }

  // Updated help with new /plan_update rule (early return before legacy blocks)
  if (false && (cmd === '/help' || cmd === '/rules')) {
    const base = (process.env.PUBLIC_BASE_URL || process.env.PUBLIC_URL || process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');
    const rulesUrl = `${base}/rules`;
    const text = [
      '📚 คำสั่งที่ใช้ได้:',
      '/begin onsite',
      '/beyond_dec',
      '/new_pride',
      '/new_member',
      '/connection+N (เช่น /connection+3)',
      '/pack3',
      '/bm_product (แนบรูป)',
      '/old_member',
      '/sop',
      '/use_product <รายละเอียด> (จำกัด 1 ครั้ง/วัน)',
      '/plan_update (ส่งแผน/อัปเดตรวมอย่างน้อย 3 ครั้ง: 1/3, 2/3 ยังไม่ให้คะแนน; ครบ 3/3 = +4; ไม่ครบทั้งเดือน = -10)',
      '/link_30d (พิมพ์แล้วส่งรูปหลักฐาน)',
      '/book (ได้ +4 ได้สูงสุด 2 ครั้ง/เดือน)',
      '/old_follow_up',
      '/new_follow_up',
      '/score',
      '/rank',
      '',
      `📜 ดูกติกาเพิ่มเติม: ${rulesUrl}`
    ].join('\n');
    await reply(evt.replyToken, text);
    return;
  }

  // Help: list commands per Rules and include clickable Rules link
  if (false && (cmd === '/help' || cmd === '/rules')) {
    const base = (process.env.PUBLIC_BASE_URL || process.env.PUBLIC_URL || process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');
    const rulesUrl = `${base}/rules`;
    const helpLines = [
      '🧭 คำสั่งที่ใช้ได้:',
      '/begin onsite',
      '/beyond_dec',
      '/new_pride',
      '/new_member',
      '/connection+N (เช่น /connection+3)',
      '/pack3',
      '/bm_product (แนบรูป)',
      '/old_member',
      '/sop',
      '/use_product <รายงาน> (จำกัด 1 ครั้ง/วัน)',
      '/plan_update success|fail',
      '/link_30d (พิมพ์แล้วส่งรูปหลักฐาน)',
      '/book (ได้ +4 ได้สูงสุด 2 ครั้ง/เดือน)',
      '/old_follow_up',
      '/new_follow_up',
      '/score',
      '/rank',
      '',
      `📖 อ่านกติกาเพิ่มเติม: ${rulesUrl}`
    ];
    await reply(evt.replyToken, helpLines.join('\n'));
    return;
  }

  if (false && (cmd === '/help' || cmd === '/rules')) {
    await reply(evt.replyToken, `📚 คำสั่งที่ใช้ได้:\n/begin onsite\n/beyond_dec\n/new_pride\n/new_member\n/connection+N (เช่น /connection+3)\n/pack3\n/bm_product\n/old_member\n/sop\n/plan_update success|fail\n/link_30d (พิมพ์แล้วส่งรูปหลักฐาน)\\n/book (ได้ +4 ได้สูงสุด 2 ครั้ง/เดือน)\n/old_follow_up\n/new_follow_up\n/score\n/rank`);
    return;
  }

  // Unknown slash-command: reply only in 1:1 chats; be quiet in groups
  if (!isGroupOrRoom) {
    await reply(evt.replyToken, pickMsg('unknown'));
  }
}

// Handle image evidence uploads
async function handleImageEvent(evt) {
  const sourceType = evt.source?.type;
  const isGroupOrRoom = sourceType === 'group' || sourceType === 'room';
  const userId = evt.source?.userId;
  if (!userId) {
    if (isGroupOrRoom) return;
    return await reply(evt.replyToken, 'ขออนุญาตไม่บันทึกภาพนี้ เพราะไม่มี userId');
  }
  const mk = monthKey();
  const already = await hasLink30dToday(userId);
  if (already) {
    const quote = pick(cleanMsgPools.inspire);
    await reply(evt.replyToken, `วันนี้บันทึก /link_30d ไว้แล้ว ขอบคุณมากครับ/ค่ะ ✨\n— ${quote}`);
    return;
  }
  const pending = await getPendingLinkToday(userId, '/link_30d');
  if (!pending) {
    // No pending request; gentle nudge to send the command first
    if (!isGroupOrRoom) {
      await reply(evt.replyToken, 'พิมพ์ /link_30d ก่อน แล้วส่งรูปอีกครั้งนะ');
    }
    return;
  }
  // Insert the /link_30d event with evidence ref (messageId)
  const imageId = evt.message?.id || 'image';
  const displayName2 = await safeGetDisplayName(userId);
  await insertEvent({ user_id: userId, display_name: displayName2, command: '/link_30d', detail: `evidence:${imageId}`, points: 0, month_key: mk });
  await clearPendingLinkToday(userId, '/link_30d');
  const quote = pick(cleanMsgPools.inspire);
  await reply(evt.replyToken, pickMsg('link_received', { quote }));
}

// Enhanced image handler supporting multiple pending evidence commands
async function handleImageEvent2(evt) {
  const sourceType = evt.source?.type;
  const isGroupOrRoom = sourceType === 'group' || sourceType === 'room';
  const userId = evt.source?.userId;
  if (!userId) {
    if (isGroupOrRoom) return;
    return await reply(evt.replyToken, 'ขออภัย ไม่สามารถบันทึกแต้มได้ เนื่องจากไม่พบ userId');
  }
  const mk = monthKey();
  const imageId = evt.message?.id || 'image';

  // Handle /link_30d evidence if pending
  const pendingLink = await getPendingLinkToday(userId, '/link_30d');
  if (pendingLink) {
    const already = await hasLink30dToday(userId);
    if (already) {
      const quote = pick(cleanMsgPools.inspire);
      await reply(evt.replyToken, `�ѹ���ѹ�֡ /link_30d ������� �ͺคุณ�ҡ��Ѻ/��� ?\n� ${quote}`);
      return;
    }
    const displayName2 = await safeGetDisplayName(userId);
    await insertEvent({ user_id: userId, display_name: displayName2, command: '/link_30d', detail: `evidence:${imageId}`, points: 0, month_key: mk });
    await clearPendingLinkToday(userId, '/link_30d');
    const quote = pick(cleanMsgPools.inspire);
    await reply(evt.replyToken, pickMsg('link_received', { quote }));
    return;
  }

  // Handle /bm_product evidence if pending (awards immediately)
  const pendingBm = await getPendingLinkToday(userId, '/bm_product');
  if (pendingBm) {
    const displayName2 = await safeGetDisplayName(userId);
    const pts = await loadRule('/bm_product', '') ?? 1;
    await insertEvent({ user_id: userId, display_name: displayName2, command: '/bm_product', detail: `evidence:${imageId}`, points: pts, month_key: mk });
    await clearPendingLinkToday(userId, '/bm_product');
    const msg = pickMsg('bm_product', { displayName: displayName2, pts: `+${pts}` });
    let composed = msg;
    const delta = Number(pts);
    if (!Number.isNaN(delta) && delta !== 0) {
      const sum = await sumUserMonth(userId, mk);
      composed = `${msg}\n💎 คะแนนสะสมรวม: ${sum} คะแนน`;
    }
    await replyWithInspire(evt.replyToken, composed, displayName2);
    return;
  }

  if (!isGroupOrRoom) {
    await reply(evt.replyToken, 'หากเป็นการส่งรูปประกอบคะแนน โปรดพิมพ์ /bm_product หรือ /link_30d ก่อน');
  }
}

// Global helper to fetch display name for a given LINE userId
async function getDisplayName(uid) {
  try {
    const res = await axios.get(`https://api.line.me/v2/bot/profile/${uid}`, {
      headers: { Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` }
    });
    return res.data.displayName || 'คุณ';
  } catch {
    return 'คุณ';
  }
}

// Clean replacement for handleImageEvent2 with fixed Thai messages
async function handleImageEvent2_fixed(evt) {
  const sourceType = evt.source?.type;
  const isGroupOrRoom = sourceType === 'group' || sourceType === 'room';
  const userId = evt.source?.userId;
  if (!userId) {
    if (isGroupOrRoom) return;
    return await reply(evt.replyToken, 'ขออภัย ไม่สามารถบันทึกแต้มได้ เนื่องจากไม่พบ userId');
  }
  const mk = monthKey();
  const imageId = evt.message?.id || 'image';

  // Handle /link_30d evidence if pending
  const pendingLink = await getPendingLinkToday(userId, '/link_30d');
  if (pendingLink) {
    const already = await hasLink30dToday(userId);
    if (already) {
      await reply(evt.replyToken, 'วันนี้ส่ง /link_30d ไปแล้วนะ ขอบคุณสำหรับรูป 🙂');
      return;
    }
    const displayName2 = await safeGetDisplayName(userId);
    await insertEvent({ user_id: userId, display_name: displayName2, command: '/link_30d', detail: `evidence:${imageId}`, points: 0, month_key: mk });
    await clearPendingLinkToday(userId, '/link_30d');
    await reply(evt.replyToken, pickMsg('link_received', { quote: pick(cleanMsgPools.inspire) }));
    return;
  }

  // Handle /bm_product evidence if pending (awards immediately)
  const pendingBm = await getPendingLinkToday(userId, '/bm_product');
  if (pendingBm) {
    const displayName2 = await safeGetDisplayName(userId);
    const pts = (await loadRule('/bm_product', '')) ?? 1;
    await insertEvent({ user_id: userId, display_name: displayName2, command: '/bm_product', detail: `evidence:${imageId}`, points: pts, month_key: mk });
    await clearPendingLinkToday(userId, '/bm_product');
    const msg = pickMsg('bm_product', { displayName: displayName2, pts: `+${pts}` });
    let composed = msg;
    const delta = Number(pts);
    if (!Number.isNaN(delta) && delta !== 0) {
      const sum = await sumUserMonth(userId, mk);
      composed = `${msg}\n💎 คะแนนสะสมรวม: ${sum} คะแนน`;
    }
    await replyWithInspire(evt.replyToken, composed, displayName2);
    return;
  }

  if (!isGroupOrRoom) {
    await reply(evt.replyToken, 'รูปนี้ยังไม่เข้าหมวดสะสมแต้ม โปรดใช้ /bm_product หรือ /link_30d ก่อน');
  }
}

// Safe display name helper with clean Thai fallback
async function safeGetDisplayName(uid) {
  try {
    const res = await axios.get(`https://api.line.me/v2/bot/profile/${uid}`, {
      headers: { Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` }
    });
    const name = (res.data && res.data.displayName) ? String(res.data.displayName) : '';
    return name || 'คุณ';
  } catch {
    return 'คุณ';
  }
}

module.exports = { handleEvent, handleImageEvent: handleImageEvent2_fixed, top10Handler, getTop10, buildWeeklySummaryText, push, monthsHandler, weeksHandler, finalizeLink30dMonth, finalizeBookMonth, finalizePlanUpdateMonth };









