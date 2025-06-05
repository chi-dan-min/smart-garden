#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <SPI.h>
#include <LoRa.h>
#include <LiquidCrystal_I2C.h>

LiquidCrystal_I2C lcd(0x27, 16, 2);
// ======= CẤU HÌNH =======
const char* ssid = "Bach Khoa 2.4";
const char* password = "bachkhoa";

const char* mqtt_server = "83c612b064b743118551ff3329a9faf5.s1.eu.hivemq.cloud";
const int mqtt_port = 8883;
const char* mqtt_username = "chidan";
const char* mqtt_password = "Chidanhn5";

// ==== CHÂN LoRa ESP32 (tùy vào board bạn nối) ====
#define LORA_SCK   18
#define LORA_MISO  19
#define LORA_MOSI  23
#define LORA_CS    5
#define LORA_RST   14
#define LORA_DIO0  26

// ====== GIỚI HẠN ========
#define SENSOR_MAX 5
#define SECTION_MAX 5

WiFiClientSecure espClient;
PubSubClient client(espClient);

// Điều khiển Relay bật bơm
#define PUMP_PIN1 11
#define PUMP_PIN2 12


// Cấu trúc vùng
struct Section {
  int sectionID;
  int sensorIDs[SENSOR_MAX];
  int sensorCount = 0;
  bool ready = false;
};

Section sections[SECTION_MAX];
bool pumpStates[SECTION_MAX]; // true = ON, false = OFF

int sectionCount = 0;
bool readyToSend = false;

// Gửi dữ liệu cảm biến
void sendSensorData(int sectionId, float value, int sensorId) {
  DynamicJsonDocument doc(256);
  doc["sectionId"] = sectionId;
  doc["sensorId"] = sensorId;
  doc["value"] = value;

  char payload[256];
  serializeJson(doc, payload);
  client.publish("garden/sensor-data", payload);
  Serial.println("Đã gửi: " + String(payload));
}

// Gửi yêu cầu danh sách vùng
void requestSectionList() {
  client.publish("request/sections", "get");
  Serial.println("Đã yêu cầu danh sách cảm biến");
}
//gửi CMD và đợi ACK
bool sendCommandWithAck(int nodeId, const char* action, int maxRetry = 3) {
  for (int attempt = 0; attempt < maxRetry; attempt++) {
    // Gửi CMD
    LoRa.beginPacket();
    LoRa.print("CMD|");
    LoRa.print(nodeId);
    LoRa.print("|");
    LoRa.print(action);
    LoRa.endPacket();

    Serial.printf("Gửi CMD|%d|%s (lần %d)\n", nodeId, action, attempt + 1);

    // Chờ ACK trong 500ms
    unsigned long startWait = millis();
    while (millis() - startWait < 500) {
      int packetSize = LoRa.parsePacket();
      if (packetSize) {
        String msg = "";
        while (LoRa.available()) msg += (char)LoRa.read();

        if (msg == ("ACK|" + String(nodeId) + "|" + String(action))) {
          Serial.println("Nhận được ACK từ Node!");
          return true;  // thành công
        }
      }
      delay(10);
    }

    Serial.println("Không nhận được ACK, thử lại...");
  }

  Serial.println("Gửi CMD thất bại sau nhiều lần thử.");
  return false;
}

// MQTT callback
void callback(char* topic, byte* payload, unsigned int length) {
  String message = "";
  for (int i = 0; i < length; i++) message += (char)payload[i];
  Serial.printf("Nhận từ [%s]: %s\n", topic, message.c_str());

  // Nhận lệnh điều khiển
  if (String(topic) == "garden/command") {
    DynamicJsonDocument doc(256);
    DeserializationError err = deserializeJson(doc, message);
    if (err) {
      Serial.println("JSON lỗi: " + String(err.c_str()));
      return;
    }

    int sectionId = doc["sectionId"];
    const char* action = doc["action"];

    // Tìm đúng section
    for (int i = 0; i < sectionCount; i++) {
      if (sections[i].sectionID == sectionId && sections[i].ready) {
        int nodeId = i + 1;  // mapping node index (0→1, 1→2, ...)

        // Gửi CMD và chờ ACK
        bool success = sendCommandWithAck(nodeId, action);

        if (success) {
          Serial.printf("Điều khiển NODE %d [%s] thành công. Yêu cầu cảm biến...\n", nodeId, action);
          pumpStates[i] = (String(action) == "ON");

          // Vẽ lại màn hình LCD với tất cả vùng
          lcd.clear();
          for (int row = 0; row < 2; row++) {
            lcd.setCursor(0, row);
            for (int col = 0; col < 2; col++) {
              int idx = row * 2 + col;
              if (idx >= sectionCount) break;
              lcd.print("Z");
              lcd.print(sections[idx].sectionID);
              lcd.print(":");
              lcd.print(pumpStates[idx] ? "ON " : "OFF");
            }
          }
        } else {
          Serial.printf("Gửi lệnh đến NODE %d thất bại sau nhiều lần.\n", nodeId);
        }

        break; // Đã xử lý đúng section
      }
    }
  }

  // Nhận danh sách vùng và cảm biến tương ứng
  if (String(topic) == "response/sections") {
    DynamicJsonDocument doc(2048);
    DeserializationError err = deserializeJson(doc, message);
    if (err) {
      Serial.println("Lỗi parse danh sách cảm biến");
      return;
    }

    sectionCount = 0;
    JsonArray sectionList = doc.as<JsonArray>();

    for (JsonObject obj : sectionList) {
      if (sectionCount >= SECTION_MAX) break;

      sections[sectionCount].sectionID = obj["sectionId"];
      JsonArray sensors = obj["sensors"];
      sections[sectionCount].sensorCount = sensors.size();

      for (int i = 0; i < sections[sectionCount].sensorCount; i++) {
        sections[sectionCount].sensorIDs[i] = sensors[i]["id"];
      }

      sections[sectionCount].ready = true;
      Serial.printf("SectionId %d có %d cảm biến\n",
        sections[sectionCount].sectionID,
        sections[sectionCount].sensorCount);

      sectionCount++;
    }

    // Reset các section không dùng nữa
    for (int i = sectionCount; i < SECTION_MAX; i++) {
      sections[i].ready = false;
    }

    readyToSend = true;
  }
}

// Kết nối lại MQTT nếu mất
void reconnect() {
  while (!client.connected()) {
    Serial.print("Kết nối lại MQTT... ");
    if (client.connect("ESP32Client", mqtt_username, mqtt_password)) {
      Serial.println("Thành công");
      client.subscribe("garden/command");
      client.subscribe("response/sections");
      requestSectionList();
    } else {
      Serial.printf("Thất bại, mã = %d. Thử lại sau 5s\n", client.state());
      delay(5000);
    }
  }
}

void setup() {
  Serial.begin(115200);
  for (int i = 0; i < SECTION_MAX; i++) {
    pumpStates[i] = false;
  }
  // === LCD ===
  lcd.init();          // Khởi tạo LCD
  lcd.backlight();     // Bật đèn nền
  lcd.clear();
  lcd.setCursor(0, 0);
  lcd.print("Smart Garden");
  lcd.setCursor(0, 1);
  lcd.print("Khoi dong...");
  
  SPI.begin(LORA_SCK, LORA_MISO, LORA_MOSI, LORA_CS);
  LoRa.setPins(LORA_CS, LORA_RST, LORA_DIO0);

  Serial.print("Đang khởi tạo LoRa...");
  if (!LoRa.begin(433E6)) {
    Serial.println("Thất bại!");
    while (1);  // Dừng nếu lỗi
  }
  Serial.println("LoRa sẵn sàng.");

  WiFi.begin(ssid, password);
  Serial.print("Kết nối WiFi");
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.println("\nWiFi OK: " + WiFi.localIP().toString());

  client.setServer(mqtt_server, mqtt_port);
  client.setCallback(callback);
  requestSectionList();
  espClient.setInsecure();
}

unsigned long lastSend = 0;
int nodeIds[] = {1, 2};
int currentNode = 0;
unsigned long lastRequest = 0;
const unsigned long requestInterval = 15000; // 15s mỗi node

// Gửi cấu hình S|nodeID|sectionID|11|12|
void sendLoRaRequestToNode(int nodeId, int sectionID, int sensorIDs[], int count) {
  LoRa.beginPacket();
  LoRa.print("S|");
  LoRa.print(nodeId);
  for (int i = 0; i < count; i++) {
    LoRa.print("|");
    LoRa.print(sensorIDs[i]);
  }
  LoRa.endPacket();
  Serial.println("Đã gửi yêu cầu tới NODE " + String(nodeId));
}

// Nhận phản hồi R|<sectionID>|<value1>|<value2>|...
void receiveSensorDataFromNode(int nodeId, int sensorIDs[], int count) {
  int packetSize = LoRa.parsePacket();
  if (packetSize) {
    String msg = "";
    while (LoRa.available()) msg += (char)LoRa.read();
    Serial.println("Đã nhận phản hồi từ NODE: " + msg);

    if (msg.startsWith("R|")) {
      msg = msg.substring(2);  // bỏ 'R|'

      // Tách nodeID đầu tiên
      int firstSep = msg.indexOf("|");
      if (firstSep == -1) return;

      int nodeID = msg.substring(0, firstSep).toInt();
      msg = msg.substring(firstSep + 1);  // bỏ nodeID
      if(nodeID != nodeId)
        return;
      for (int i = 0; i < count; i++) {
        int sep = msg.indexOf("|");
        String valStr = (sep >= 0) ? msg.substring(0, sep) : msg;
        float value = valStr.toFloat();

        sendSensorData(sections[nodeID-1].sectionID, value, sensorIDs[i]);

        if (sep == -1) break;
        msg = msg.substring(sep + 1);
      }
    }
  }
}

void receiveLoRaDataAndPublish() {
  for (int i = 0; i < sectionCount; i++) {
    if (sections[i].ready) {
      receiveSensorDataFromNode(  
        i + 1,                          
        sections[i].sensorIDs,
        sections[i].sensorCount
      );
    }
  }
}

void loop() {
  if (!client.connected() || sectionCount == 0) reconnect();
  client.loop();

  unsigned long now = millis();

  // Gửi yêu cầu tới từng node lần lượt
  if (now - lastRequest > requestInterval) {
    sendLoRaRequestToNode(currentNode + 1, sections[currentNode].sectionID,sections[currentNode].sensorIDs,sections[currentNode].sensorCount);
    currentNode = (currentNode + 1) % sectionCount;
    lastRequest = now;
  }

  //Nhận dữ liệu LoRa từ node
  receiveLoRaDataAndPublish();
}