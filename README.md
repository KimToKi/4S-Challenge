# Disneyland Challenge — LINE Bot

ระบบสะสมคะแนนรายเดือนสำหรับกลุ่ม LINE ที่ทำงานร่วมกับฐานข้อมูล Supabase/Postgres

## การตั้งค่า
1. สร้างไฟล์ `.env` และกำหนดตัวแปรสำคัญ:
   ```env
   LINE_CHANNEL_ACCESS_TOKEN=...
   LINE_TARGET_ID=...
   SUPABASE_DB_URL=postgresql://USER:PASSWORD@HOST:PORT/DATABASE
   # หรือใช้ DATABASE_URL / SUPABASE_POSTGRES_URL
   ```
   > หมายเหตุ: เชื่อมต่อ TLS เป็นค่าเริ่มต้น หากใช้ฐานข้อมูลโลคอลให้ตั้งค่า `SUPABASE_DB_URL` เป็น connection string ที่ขึ้นต้นด้วย `postgres://localhost...`
2. ติดตั้ง dependency แล้ว apply schema เข้าสู่ฐานข้อมูล Supabase:
   ```bash
   npm install
   npm run init-db
   ```
3. เริ่มเซิร์ฟเวอร์:
   ```bash
   npm start
   ```

## งานที่สำคัญ
- `logic.js` จัดการ webhook จาก LINE, บันทึกคะแนน และคำนวณอันดับผ่าน Supabase
- `server.js` ให้บริการ webhook, leaderboard และ cron job
- `schema.sql` ใช้กับ `npm run init-db` เพื่อสร้างตารางและกติกาคะแนนบน Supabase

## ค่าปรับแต่งเพิ่มเติม
- `WEEKLY_CRON` / `WEEKLY_TZ` : ตั้งเวลา push อันดับรายสัปดาห์ (ค่าเริ่มต้น จันทร์ 09:00 Asia/Bangkok)
- `MONTHLY_CRON` / `MONTHLY_TZ` : ตั้งเวลา settlement รายเดือน (ค่าเริ่มต้นทุกวัน 23:55 Asia/Bangkok)
- `ADMIN_KEY` : เปิด endpoint แอดมินสำหรับ trigger manual push/settlement
  - `/admin/weekly-push?key=...` : ส่งอันดับ Top 10 ปัจจุบันเข้า LINE ทันที
  - `/admin/link30d-settle?key=...&ym=YYYY-MM&push=1` : สรุปคะแนน /link_30d และ (ถ้า `push=1`) ส่งข้อความเข้า LINE
  - `/admin/book-settle?key=...&ym=YYYY-MM` : ตรวจสอบเดือนที่เลือกและให้โบนัส +1 สำหรับผู้ที่ส่ง `/book` รวมแล้วอ่านเกิน 300 หน้าในเดือนนั้น

## หมายเหตุ
- ตัวโค้ดจะเชื่อมต่อ Supabase ทุกครั้งที่มีการบันทึกหรืออ่านข้อมูล จึงไม่ต้องมีไฟล์ `db.sqlite` ภายในเซิร์ฟเวอร์อีกต่อไป
- หากใช้งานครั้งแรกแนะนำให้รัน `npm run init-db` เพื่อให้มี score rules พื้นฐานในฐานข้อมูล
