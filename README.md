# Disneyland Challenge — LINE Bot

ระบบสะสมคะแนนรายเดือนสำหรับกลุ่ม LINE  
ใช้ Node.js + SQLite + webhook + leaderboard HTML

## วิธีใช้งาน
1. สร้างไฟล์ `.env` แล้วใส่ LINE_CHANNEL_ACCESS_TOKEN
2. รัน:
   ```bash
   npm install
   npm run init-db
   npm start
   ```

### ตั้งค่าประกาศอันดับรายสัปดาห์ (Weekly Push)
- ใส่ `LINE_TARGET_ID` (หรือ `LINE_GROUP_ID`/`LINE_USER_ID`) ใน `.env` เพื่อให้บอทส่งประกาศไปยังห้อง/ผู้ใช้เป้าหมาย
- ปรับเวลาได้ด้วย `WEEKLY_CRON` (ดีฟอลต์: จันทร์ 09:00) และ `WEEKLY_TZ` (ดีฟอลต์: Asia/Bangkok)
- ทดสอบส่งแบบแมนนวลได้ หากตั้ง `ADMIN_KEY` แล้วเรียก `GET /admin/weekly-push?key=YOUR_KEY`
