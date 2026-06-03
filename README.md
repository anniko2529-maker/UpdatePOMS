# POMS Dashboard

เว็บ Dashboard สำหรับติดตามข้อมูลบริษัทตามรูปจาก `https://poms.diw.go.th/` ผ่าน API public ของ POMS โดย polling ข้อมูล CEMS/WPMS และตรวจว่าข้อมูลไม่อัปเดตเกิน 3 ชั่วโมงหรือไม่

## วิธีใช้งาน

1. ติดตั้ง Node.js 18 ขึ้นไป
2. รันคำสั่ง:

```powershell
npm start
```

3. เปิดเว็บ:

```text
http://localhost:3000
```

## ตั้งค่าอีเมล Alert

คัดลอก `config.example.json` เป็น `config.json` แล้วกรอก SMTP และผู้รับอีเมล

```json
{
  "recipients": ["operator@example.com"],
  "smtp": {
    "host": "smtp.example.com",
    "port": 587,
    "secure": false,
    "user": "poms-alert@example.com",
    "pass": "password",
    "from": "poms-alert@example.com"
  }
}
```

ระบบจะส่งอีเมลเมื่อข้อมูลล่าสุดของบริษัทใดบริษัทหนึ่งค้างเกิน `staleThresholdMinutes` ค่าเริ่มต้นคือ 180 นาที และจะไม่ส่งซ้ำถี่กว่า `alertCooldownMinutes`

## บริษัทที่ติดตาม

- บริษัท ไทยลู้บเบส จำกัด (มหาชน)
- บริษัท ไทยออยล์ จำกัด (มหาชน) (49)
- บริษัท ไทยออยล์ จำกัด(มหาชน)(101)
- บริษัท ท็อป เอสพีพี จำกัด
- บริษัท ไทยออยล์ จำกัด (มหาชน) (88)
- บริษัท ลาบิกซ์ จำกัด
- บริษัท ไทยพาราไซลีน จำกัด
