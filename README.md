# Disneyland Challenge — LINE Bot

ระบบสะสมคะแนนรายเดือนสำหรับกลุ่ม LINE ที่บันทึกข้อมูลลง Supabase/Postgres พร้อมรองรับคำสั่งทั้งหมดตามกติกาในหน้า [Rules](https://disneyland-challenge.onrender.com/rules) รวมถึงคะแนนจำนวนเต็มและทศนิยม

## ภาพรวม
- รับคำสั่งจาก LINE Messaging API และบันทึกเหตุการณ์ลงตาราง `events`
- รองรับคำสั่งที่ต้องรอรูป (เช่น `/link_30d`, `/bm_product`, `/use_product`) ด้วยคิว `pending`
- มีบริการแสดง Top 10 (รายเดือน/รายสัปดาห์/สะสมทั้งหมด) และหน้า Rules แบบสแตติก
- เชื่อมระบบกับ Supabase เพื่อใช้งาน Postgres และ REST API เดียวกัน

## การเตรียมค่าใช้จ่าย
1. เปิดโครงการ LINE Messaging API แล้วสร้าง Channel Access Token
2. สร้างฐานข้อมูลบน Supabase (หรือ Postgres ที่เข้าถึงได้จากภายนอก)
3. เตรียมค่าแวดล้อมสำหรับการรันเซิร์ฟเวอร์

สร้างไฟล์ `.env` แล้วกำหนดค่าที่จำเป็น เช่น
```env
LINE_CHANNEL_ACCESS_TOKEN=xxxx
LINE_TARGET_ID=Uxxxxxxxxxxxxxx        # groupId หรือ userId ที่ต้องการ push ข้อความ
SUPABASE_URL=https://xxxxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=xxxxx        # ใช้ service role สำหรับ insert/update
SUPABASE_DB_URL=postgresql://USER:PASSWORD@HOST:PORT/DATABASE
SCORE_TIMEZONE=Asia/Bangkok            # เวลาอ้างอิงสำหรับตัดรอบ (ค่าเริ่มต้น Asia/Bangkok)
WEEKLY_CRON=0 9 * * 1                  # ตัวอย่างตั้งเวลา push รายสัปดาห์
MONTHLY_CRON=55 23 * * *              # ตัวอย่างตั้งเวลาสรุปรายเดือน (รันวันสิ้นเดือนเท่านั้น)
MANUAL_SETTLE_SECRET=NewSilver21%      # รหัสสำหรับคำสั่ง /settle (แก้ไขได้)
```
> หากเชื่อมต่อฐานข้อมูลที่ไม่ต้องใช้ TLS ให้ระบุ `?sslmode=disable` ใน `SUPABASE_DB_URL`

## ขั้นตอนติดตั้ง
1. ติดตั้ง dependencies
   ```bash
   npm install
   ```
2. สร้างตารางและ seed กติกาพื้นฐานเข้าสู่ Supabase (รันครั้งแรกหรือเมื่อ reset ระบบ)
   ```bash
   npm run init-db
   ```
   - สคริปต์จะตรวจสอบ/สร้างตาราง `events`, `pending`, `score_rules`
   - ฟิลด์คะแนนถูกบังคับเป็นชนิด `NUMERIC(12,2)` เพื่อรองรับคะแนนทศนิยม
3. เริ่มเซิร์ฟเวอร์
   ```bash
   npm start
   ```
   เซิร์ฟเวอร์จะเปิดที่ `http://localhost:3000` (หรือพอร์ตที่กำหนดใน `PORT`)

## Endpoint ที่สำคัญ
| Endpoint | คำอธิบาย |
|----------|-----------|
| `POST /webhook` | จุดรับ webhook จาก LINE (อย่าลืมตั้งค่าให้ส่ง raw body) |
| `GET /top10` | ดึงอันดับ Top 10 (รองรับ query `scope=all`, `scope=week`, `ym`, `yw`) |
| `GET /months` | รายชื่อเดือนที่มีข้อมูลเพื่อใช้เลือกดูย้อนหลัง |
| `GET /weeks` | รายชื่อสัปดาห์ (ISO Week) ที่มีข้อมูล |
| `GET /` | หน้า Top 10 แบบเรียลไทม์ |
| `GET /rules` | หน้า Rules ตามลิงก์อ้างอิง |
| `GET /rules-image.png` | รูปกติกาแบบสรุปสำหรับส่งใน LINE |

## การรีเซตระบบ/ฐานข้อมูล
- ใช้ `npm run init-db` เพื่อสร้างตารางและ seed ค่ากติกาใหม่
- หากต้องการล้างคะแนน ให้ลบข้อมูลในตาราง `events` (เช่น ผ่าน Supabase SQL) แล้วรัน `npm run init-db` อีกครั้งเพื่อยืนยัน schema
- คำสั่ง `/settle` (พร้อมรหัสลับ) จะรันสรุปโบนัสปลายเดือนตามกติกา `/link_30d` และ `/book`

## คำสั่งที่รองรับ (สรุปจาก Rules)
- **Multiplier**: `/begin`, `/beyond_dec`, `/new_pride`, `/new_member` จะให้คะแนนเพิ่มแบบ 1 → 2 → 4 → 8 … ตามจำนวนครั้งในเดือนเดียวกัน
- **Fixed Score**: `/pack3` (+4), `/bm_product` (+1 พร้อมรูป), `/old_member` (+1), `/sop` (+2)
- **รายงานรายวัน**: `/use_product` (+0.1 วันละ 1 ครั้งพร้อมรูป), `/link_30d` (+0.1 ต่อวันพร้อมรูป, ครบทั้งเดือนได้โบนัส +1)
- **ติดตามงาน**: `/old_follow_up` (+1), `/new_follow_up` (+2), `/connection+N` (+N)
- **บันทึกเป้าหมาย**: `/plan_update` เก็บได้สูงสุด +4 ต่อเดือน (ตั้งเป้าต้นเดือน +1 และอัปเดตเสาร์/อาทิตย์อีก +1 ต่อสัปดาห์)
- **อ่านหนังสือ**: `/book <หน้าที่อ่าน>` (+0.01 ต่อหน้า) และหากครบ 300 หน้า/เดือน รับโบนัส +1 อัตโนมัติ
- **เช็คคะแนน/อันดับ**: `/score`, `/rank`, `/rules`, `/help`, `/groupid`, `/settle <secret>`

## การ Deploy
- รองรับการทำงานบน Render/Heroku/Vercel ฯลฯ ที่ใช้ Node.js ได้
- ต้องกำหนด webhook URL ของ LINE ให้ตรงกับ `<BASE_URL>/webhook`
- ตั้งค่า cron ผ่าน environment (`WEEKLY_CRON`, `MONTHLY_CRON`) เพื่อให้ระบบ push สรุปรายสัปดาห์/สรุปรายเดือนอัตโนมัติ

## การดูแลรักษา
- ไฟล์ log ในโฟลเดอร์โปรเจ็กต์ถูกลบออก ให้ตรวจสอบ log ผ่าน platform ที่ deploy แทน
- ตรวจสอบค่า Access Token ของ LINE และ Supabase Service Role ให้อัปเดตอยู่เสมอ
- สำรองฐานข้อมูลผ่าน Supabase อย่างน้อยเดือนละครั้งเพื่อกันข้อมูลสูญหาย

> หากมีการแก้กติกาใหม่ สามารถแก้ไขหน้า `views/rules.html` ให้ตรงกับลิงก์อ้างอิง และปรับเงื่อนไขใน `logic.js` เพิ่มเติมได้
