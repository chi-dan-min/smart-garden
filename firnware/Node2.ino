#include <SPI.h>
#include <LoRa.h>

// ==== CẤU HÌNH CHÂN LoRa CHO ESP32 ====
#define LORA_SCK   18
#define LORA_MISO  19
#define LORA_MOSI  23
#define LORA_CS    5
#define LORA_RST   14
#define LORA_DIO0  26

#define NODE_ID    2
#define LORA_FREQ  433E6

// ==== RELAY điều khiển bơm ====
#define RELAY_PIN  12  // chọn GPIO phù hợp ESP32, ví dụ 12 hoặc 27

// ==== DANH SÁCH CẢM BIẾN CÓ SẴN ====
const int MAX_SENSORS = 5;

// Giả định chân analog: 32, 33, 34, 35, 36, 39 cho ESP32 (analogRead)
struct Sensor {
  int id;
  int pin;
};

Sensor mySensors[MAX_SENSORS] = {
  {5, 32},    // soil
  {6, 33},    // light
  {7, 34}     //dht
};
int mySensorCount = 3;

void setup() {
  Serial.begin(115200);
  while (!Serial);

  pinMode(RELAY_PIN, OUTPUT);
  digitalWrite(RELAY_PIN, LOW);  // bơm mặc định OFF

  // Khởi tạo SPI trước khi khởi tạo LoRa
  SPI.begin(LORA_SCK, LORA_MISO, LORA_MOSI, LORA_CS);
  LoRa.setPins(LORA_CS, LORA_RST, LORA_DIO0);
  if (!LoRa.begin(LORA_FREQ)) {
    Serial.println("Lỗi khởi tạo LoRa.");
    while (1);
  }
  Serial.println("LoRa đã sẵn sàng (NODE_ID = " + String(NODE_ID) + ")");
}

void loop() {
  int packetSize = LoRa.parsePacket();
  if (packetSize) {
    String msg = "";
    while (LoRa.available()) msg += (char)LoRa.read();

    Serial.println(" Nhận được: " + msg);

    // ==== 1. XỬ LÝ LỆNH CẢM BIẾN ====
    if (msg.startsWith("S|")) {
    // Tách các trường nodeId, sectionId, sensorId[]
    int firstSep = msg.indexOf('|');
    int secondSep = msg.indexOf('|', firstSep + 1);
    int thirdSep = msg.indexOf('|', secondSep + 1);

    int receivedNodeId = msg.substring(firstSep + 1, secondSep).toInt();
    // int sectionId = msg.substring(secondSep + 1, thirdSep).toInt();

    if (receivedNodeId != NODE_ID) return;

    // Tách danh sách sensorId động
    int reqSensorIDs[MAX_SENSORS];
    int reqCount = 0;
    int startIdx = thirdSep + 1;
    while (startIdx < msg.length()) {
      int sepIdx = msg.indexOf('|', startIdx);
      String idStr;
      if (sepIdx == -1) {
        idStr = msg.substring(startIdx); 
        startIdx = msg.length();
      } else {
        idStr = msg.substring(startIdx, sepIdx);
        startIdx = sepIdx + 1;
      }
      if (idStr.length() > 0 && reqCount < MAX_SENSORS) {
        reqSensorIDs[reqCount++] = idStr.toInt();
      }
    }

    // Gửi phản hồi R|<sectionID>|<value>|<value>|...|
    LoRa.beginPacket();
    LoRa.print("R|");
    LoRa.print(NODE_ID);
    for (int i = 0; i < reqCount; i++) {
      int sensorId = reqSensorIDs[i];
      float value = -1;
      for (int j = 0; j < mySensorCount; j++) {
        if (mySensors[j].id == sensorId) {
          int analogVal = analogRead(mySensors[j].pin);
          value = analogVal * (3.3 / 4095.0);  
          LoRa.print("|");
          LoRa.print(value, 2);
          break;
        }
      }
    }

    LoRa.endPacket();
    Serial.println("Đã gửi phản hồi dữ liệu R|...");
  }
    // ==== 2. XỬ LÝ LỆNH BẬT/TẮT ====
  else if (msg.startsWith("CMD|")) {
      int idStart = 4;
      int idEnd = msg.indexOf("|", idStart);
      int receivedNodeId = msg.substring(idStart, idEnd).toInt();

      if (receivedNodeId != NODE_ID) return;

      String action = msg.substring(idEnd + 1);
      action.trim();

      if (action == "ON") {
        digitalWrite(RELAY_PIN, HIGH);
        Serial.println("BẬT bơm");
      } else if (action == "OFF") {
        digitalWrite(RELAY_PIN, LOW);
        Serial.println("TẮT bơm");
      }

      // Gửi ACK
      LoRa.beginPacket();
      LoRa.print("ACK|");
      LoRa.print(NODE_ID);
      LoRa.print("|");
      LoRa.print(action);
      LoRa.endPacket();

      Serial.println("Gửi phản hồi ACK");
    }
  }

  delay(10);
}
