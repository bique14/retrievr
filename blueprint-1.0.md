:::writing{variant=“document” id=“58142”}
Blueprint: P2P File Transfer Web App (1-to-1)

1. Vision
   สร้าง Web Application สําหรับรับส่งไฟล์ระหว่างผู้ใช้ 2 คน โดยมี เป้ าหมายดังนี้
   Goals
   • ส่งไฟล์แบบ Peer-to-Peer (P2P)
   • ไฟล์ไม่ผ่านเซิร์ฟเวอร์ (Server ใช้เฉพาะ Signaling)
   • รองรับไฟล์ขนาดใหญ่มาก (หลายร้อย GB หากพื้นที่ดิสก์เพียงพอ)
   • รองรับ Resume หลังการเชื่อมต่อหลุด
   • รองรับ Pause / Resume
   • รองรับการส่งหลายไฟล์
   • รองรบัการส่งท้งัโฟลเดอร์
   • ใช้งานผ่าน Browser โดยไม่ต้องติดต้งัโปรแกรม
   • รองรับ Desktop เป็ นหลัก
   • Mobile ใช้งานได้ในระดับพื้นฐาน
   ⸻
2. High Level Architecture
   +-----------------------+
   | Signaling Server |
   | WebSocket |
   | No File Storage |
   +-----------+-----------+
   |
   Exchange SDP / ICE
   |

---

| |
| |
Sender Browser Receiver Browser
| |
+--------- WebRTC -----------+
DataChannel (P2P)
File never goes through the server.
Server มีหน้าที่ เพียง
• สร้าง Session
• จับคู่ผู้ใช้
• แลก SDP
• แลก ICE Candidate
หลังจากเชื่อมต่อสําเร็จ
Server ไม่ เกี่ยวข้องกับข้อมูลอีก
⸻ 3. Technology Stack
Frontend
• TypeScript
• SvelteKit (แนะนํา)
• Tailwind CSS
• Vite
เหตุผล
• Bundle เล็ก
• เร็ว
• Reactive
• เหมาะกับงาน Browser API
React หรือ Vue ก็ใช้ได้
⸻
Browser APIs
WebRTC DataChannel
ใช้สําหรบัส่งข้อมูลท้งัหมด
ห้ามใช้ WebSocket ส่งไฟล์
⸻
Streams API
ใช้ Stream ไฟล์
File.stream()
ReadableStream
WritableStream
เพ่ือไม่โหลดไฟล์ท้งัก้อนเข้า RAM
⸻
File System Access API
ใช้เขียนไฟล์ลงดิสก์ทีละ Chunk
ข้อดี
• Resume ได้
• ไม่ต้องรอโหลดครบแล้วค่อย Save
Fallback
IndexedDB
สําหรับ Browser ที่ไม่รองรับ
⸻
Web Crypto API
ใช้
SHA-256
สําหรับ
• Chunk Hash
• File Hash
⸻
IndexedDB
ใช้เก็บ
• Resume Metadata
• Session
• Chunk Status
⸻ 4. Backend
Backend เล็กมาก
ใช้
Node.js
หรือ
หรือ
Bun
Framework
Fastify
หรือ
Hono
⸻
ทําหน้าที่ เพียง
Create Session
Join Session
WebSocket Signaling
ICE Exchange
Disconnect Notification
ไม่มี
• Upload
• Download
• File Storage
⸻ 5. Connection Flow
User A
↓
Create Session
↓
ABC123
↓
Share Link / QR
↓
User B Join
↓
Exchange SDP
↓
Exchange ICE
↓
WebRTC Connected
↓
Open DataChannel
↓
Start Transfer
⸻ 6. Session Design
Session
Session ID
Created Time
Expires
Peers
Status
หมดอายุภายใน
30 นาที
หากไม่มีคน Join
⸻ 7. File Transfer Protocol
แบ่งไฟล์เป็ น
Chunk
เช่น
Chunk Size
1 MB
หรือ
2 MB
หรือ
4 MB
แต่ละ Chunk
File ID
Chunk Index
Offset
Length
Checksum
Payload
⸻
Metadata
File Name
File Size
Mime
Last Modified
Total Chunks
SHA256
Receiver ตอบกลับ
ACK
เป็ นช่วง
เช่น
ACK
0-99
100-199
ไม่ต้อง ACK ทุก Chunk
⸻ 8. Resume Protocol
Receiver
เก็บ
Received Chunk Bitmap
Last Verified Chunk
Completed Chunks
หากหลุด
Reconnect
Receiver ส่ง
Resume
Need
1234-9999
Sender
ส่งต่อทันที
ไม่เร่
ิมใหม่
⸻ 9. Integrity
ทุก Chunk
มี
SHA256
Receiver
Verify
ทันที
หากเสีย
Request
เฉพาะ Chunk น้นั
หลังรับครบ
Verify
File Hash
อีกครง้ั
⸻ 10. Transfer Queue
รองรับ
หลายไฟล์
หลายโฟลเดอร์
Queue
Waiting
Sending
Paused
Completed
Failed
ผู้ใช้
สามารถ
Pause
Resume
Cancel
ได้ทุกไฟล์
⸻ 11. Folder Transfer
ใช้
webkitdirectory
เก็บ
Relative Path
เช่น
Photos/
Photos/2025/
Photos/2025/img1.jpg
Receiver
สร้างโครงสร้างเหมือนต้นฉบับ
⸻ 12. Flow Control
WebRTC
มี
buffer
ต้องควบคุม
bufferedAmount
หาก
bufferedAmount

> Threshold
> หยุดส่งช่วัคราว
> รอ
> bufferedamountlow
> แล้วส่งต่อ
> ไม่เช่นน้นั Browser อาจกิน RAM มากผิดปกติ
> ไม่เช่นน้นั Browser อาจกิน RAM มากผิดปกติ
> ⸻ 13. Encryption
> WebRTC
> มี
> DTLS
> อยู่แล้ว
> สามารถเพ่
> ิม
> Application Encryption
> อีกช้นั
> เช่น
> AES-GCM
> โดยแลก Key ผ่าน ECDH
> สําหรบัผู้ใช้ท่ีต้องการความม่นั ใจเพ่
> ิมเติม
> ⸻ 14. UI
> Sender
> Drag File
> Drag Folder
> Progress
> Speed
> Remaining Time
> Pause
> Resume
> Cancel
> Receiver
> Accept
> Reject
> Choose Save Location
> Progress
> Speed
> Resume
> ⸻ 15. QR Pairing
> ผู้สร้าง
> สร้าง
> Session
> ↓
> QR
> ↓
> อีกเครื่อง Scan
> ↓
> Join
> ↓
> Connected
> ไม่ต้อง Login
> ⸻ 16. Link Pairing
> https://app.com/s/ABC123
> เปิ ด
> Join
> ทันที
> ⸻ 17. Performance
> ใช้
> Pipeline
> Read Chunk
> ↓
> Hash
> ↓
> Queue
> ↓
> Send
> ↓
> ACK
> ↓
> Next
> ไม่ควร
> Read
> Entire File
> Into Memory
> เด็ดขาด
> ⸻ 18. Error Recovery
> กรณี
> Chunk เสีย
> Retransmit
> เฉพาะ Chunk
> กรณี
> Disconnect
> Reconnect
> Resume
> กรณี
> Browser Refresh
> อ่าน Resume Metadata
> แล้วต่อได้
> ⸻ 19. Browser Compatibility
> Chrome
> ★★★★★
> Edge
> ★★★★★
> Brave
> ★★★★★
> Opera
> ★★★★★
> Firefox
> ★★★★☆
> Safari
> ★★★☆☆
> Safari
> รองรับ
> WebRTC
> แต่
> File System Access API
> ยังมีข้อจํากัด
> ⸻ 20. Security
> • จํากัด Session อายุส้นั
> • Session ID เป็ น Random อย่างน้อย 128-bit
> • ไม่ เก็บไฟล์บน Server
> • Rate Limit การสร้าง Session
> • จํากัดจํานวน Peer = 2
> • ป้ องกัน Spam Join
> • ตรวจสอบ Chunk Size
> • ตรวจสอบ Metadata
> • จํากัดขนาด Metadata
> ⸻ 21. Limitations
> NAT
> บางเครือข่าย
> P2P
> เชื่อมไม่ได้
> ควรมี
> STUN
> อย่างน้อย
> stun:stun.l.google.com:19302
> หากต้องการ
> Success Rate
> เกือบ 100%
> ต้องมี
> TURN
> ซ่ึงทําให้
> File
> ผ่าน Server
> ⸻ 22. Future Features
> • ส่งข้อความระหว่างส่งไฟล์
> • Clipboard Transfer
> • Resume ข้ามวัน
> • Multi-device Pairing
> • Transfer History
> • Favorite Devices
> • LAN Discovery
> • Compression สําหรับไฟล์ที่บีบอัดได้
> • Delta Transfer (ส่งเฉพาะส่วนที่ เปลี่ยนของไฟล์)
> • Adaptive Chunk Size ตามคุณภาพเครือข่าย
> ⸻ 23. Recommended Libraries
> UI
> • SvelteKit
> • TailwindCSS
> Networking
> • Native WebRTC
> • Native WebSocket
> Utilities
> • zod
> • nanoid
> • idb
> • pako (ถ้าต้องการ Compression)
> Backend
> • Fastify
> • ws
> • Redis (ถ้าต้อง Scale หลาย Instance)
> ⸻ 24. Project Structure
> apps/
> web/
> packages/
> protocol/
> ui/
> shared/
> server/
> signaling/
> docs/
> protocol.md
> architecture.md
> ⸻ 25. Development Phases
> Phase 1
> • Signaling
> • WebRTC
> • ส่งไฟล์เล็ก
> Phase 2
> • Chunk
> • Progress
> • Multiple Files
> Phase 3
> • Resume
> • Folder
> • Hash Verification
> Phase 4
> • QR
> • Pause
> • Speed Meter
> • ETA
> Phase 5
> • Mobile Optimization
> • Encryption Layer
> • LAN Discovery
> • Performance Tuning
> ⸻ 26. Non-Functional Requirements
> • รองรับไฟล์ขนาดใหญ่มากโดยไม่ใช้ RAM ตามขนาดไฟล์
> • รองรับ Resume หลังการเชื่อมต่อหลุด
> • รองรับการเชื่อมต่อข้ามประเทศ
> • ใช้ Server เฉพาะ Signaling
> • ไม่มีการเก็บไฟล์บน Cloud
> • ตรวจสอบความถูกต้องของข้อมูลด้วย SHA-256
> • ใช้งานง่ายแบบ “สร้างห้อง → แชร์ลิงก์หรือ QR → รับไฟล์”
> • โค้ดแยกช้นั (Protocol / UI / Networking) เพื่อให้สามารถเปลี่ยน Frontend
> Framework หรือพัฒนาเป็ น Desktop App (เช่น Tauri หรือ Electron) ในอนาคตได้
> :::
> เอกสารนี้สามารถใช้เป็ น Blueprint ระดับสถาปัตยกรรมได้แล้ว แต่ถ้าจะให้ AI เช่น Claude Code,
> Codex หรือ Gemini ช่วยพฒั นาท้งัโปรเจกต์ผมแนะนําให้แตกต่อเป็ นเอกสารอีก 3 ฉบับ ได้แก่

1. Protocol Specification ระบุรูปแบบของทุก message ที่แลกเปลี่ยนกัน (เช่น
   FILE_INFO, CHUNK, ACK, RESUME, ERROR, COMPLETE) รวมถึง state machine ของ
   sender/receiver
2. System Design อธิบายโครงสร้างโมดูล, data flow, sequence diagram และเหตุผล
   ในการเลือกเทคโนโลยี
3. Implementation Roadmap แยกเป็ น milestone และ task ย่อย เพื่อให้ AI หรือทีม
   พัฒนาสร้างทีละส่วนได้อย่างเป็ นระบบ ลดโอกาสต้องรื้อสถาปัตยกรรมภายหลัง
