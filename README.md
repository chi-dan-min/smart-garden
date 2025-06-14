# Hệ thống Tưới Cây Thông Minh sử dụng ESP32, MQTT và Node.js

Dự án xây dựng hệ thống tưới cây tự động gồm nhiều vùng tưới (sections), mỗi vùng có thể gán nhiều loại cảm biến khác nhau. Hệ thống sử dụng giao thức MQTT để giao tiếp giữa thiết bị phần cứng (ESP32) và server xử lý trung tâm (Node.js + Express + MySQL).

---

## Tính năng nổi bật

- Quản lý nhiều vùng tưới và cảm biến linh hoạt
- Hỗ trợ 3 chế độ điều khiển:
  - Thủ công (Manual)(nhằm mục đích test command không ghi log)
  - Theo lịch tưới (Schedule)
  - Theo ngưỡng cảm biến (Threshold)
- Giao tiếp MQTT giữa ESP32 và server
- Giao diện web thân thiện để:
  - Quản lý vùng, cảm biến, lịch tưới và ngưỡng
  - Theo dõi và điều khiển hệ thống tưới
- Ghi log lịch sử tưới đầy đủ

---

## Công nghệ sử dụng

| Thành phần        | Công nghệ                             |
|-------------------|----------------------------------------|
| Thiết bị IoT      | ESP32 (Arduino C++)                    |
| Giao tiếp         | MQTT (HiveMQ Cloud Broker)            |
| Backend           | Node.js + Express                      |
| Cơ sở dữ liệu     | MySQL                                  |
| Frontend (UI)     | EJS (Embedded JavaScript Templates)   |
| Giao diện giao tiếp | HTML + CSS                           |

---

## Cấu trúc thư mục

```bash
├── routes/             # Express routes (quản lý sections, schedules, thresholds)
├── views/              # Giao diện EJS
├── public/             # CSS / JS client
├── db.js               # Kết nối MySQL
├── app.js              # File chính khởi chạy server
├── .env                # Cấu hình database
├── firmware/           # Mã nguồn Arduino cho ESP32
│   └── node_firmware.ino
