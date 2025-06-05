const express = require('express');
const router = express.Router();
require('dotenv').config();
const mysql = require('mysql');
const mqtt = require('mqtt');
const cron = require('node-cron');
const pumpStates = {}; // sectionId => { isOn: true, startTime: timestamp }
// Kết nối tới HiveMQ Cloud Broker
const mqttClient = mqtt.connect('mqtts://83c612b064b743118551ff3329a9faf5.s1.eu.hivemq.cloud:8884', {
  username: 'chidan',
  password: 'Chidanhn5',
  port: 8883 // Nếu dùng SSL
});

// Đăng ký nhận MQTT topic request/sections
mqttClient.subscribe('request/sections', (err) => {
  if (err) {
    console.error('Failed to subscribe to request/sections:', err.message);
  } else {
    console.log('Subscribed to request/sections');
  }
});
mqttClient.subscribe('garden/sensor-data', (err) => {
  if (err) {
    console.error('Failed to subscribe to garden/sensor-data:', err.message);
  } else {
    console.log('Subscribed to garden/sensor-data');
  }
});


mqttClient.on('message', (topic, message) => {
  // ... Các topic khác bạn đang xử lý

  if (topic === 'request/sections' && message.toString() === 'get') {
    db.query('SELECT id FROM sections', (err, sectionResults) => {
      if (err) {
        console.error('DB error:', err);
        mqttClient.publish('response/sections', JSON.stringify([]));
        return;
      }

      db.query('SELECT section_id, sensor_type_id FROM section_sensors', (err, sensorResults) => {
        if (err) {
          console.error('DB error:', err);
          mqttClient.publish('response/sections', JSON.stringify([]));
          return;
        }

        // Định dạng đúng yêu cầu
        const response = sectionResults.map(section => ({
          sectionId: section.id,
          sensors: sensorResults
            .filter(sensor => sensor.section_id === section.id)
            .map(sensor => ({ id: sensor.sensor_type_id }))
        }));

        mqttClient.publish('response/sections', JSON.stringify(response));
        console.log('Published response/sections:', response);
      });
    });
  }
  if (topic === 'garden/sensor-data') {
    try {
      const data = JSON.parse(message.toString());
      const { sectionId, sensorId, value } = data;

      if (!sectionId || !sensorId || value === undefined) return;

      db.query(
        `INSERT INTO sensor_data (section_id, sensor_type_id, value)
         VALUES (?, ?, ?)`,
        [sectionId, sensorId, value],
        (err) => {
          if (err) {
            console.error('Lỗi khi lưu sensor_data:', err);
          } else {
            console.log(`[SENSOR] Đã lưu: section ${sectionId}, type ${sensorId}, value ${value}`);
          }
        }
      );
    } catch (err) {
      console.error('Lỗi parse JSON sensor-data:', err.message);
    }
  }
});

// Bắt lỗi khi không kết nối được (sai URL, không có broker...)
mqttClient.on('error', (err) => {
  console.error('MQTT connection error:', err.message);

  // Kết thúc client nếu cần
  mqttClient.end();
});
// Kết nối đến cơ sở dữ liệu MySQL
const db = mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE
});
db.connect((err) => {
    if (err) {
        console.error('Error connecting to MySQL:', err);
        return;
    }
    console.log('Connected to MySQL database');
});

// Route gửi lệnh bật/tắt đèn LED
router.post('/toggle-pump/:sectionId', (req, res) => {
  const sectionId = parseInt(req.params.sectionId);
  const { action } = req.body;

  if (!['ON', 'OFF'].includes(action)) {
    return res.status(400).json({ error: 'Lệnh không hợp lệ' });
  }

  const topic = 'garden/command';
  const payload = JSON.stringify({ sectionId, action });

  mqttClient.publish(topic, payload, {}, (err) => {
    if (err) {
      console.error(`Failed to send message to ${topic}:`, err);
      return res.status(500).json({ error: 'Lỗi khi gửi lệnh' });
    }

    console.log(`Gửi lệnh ${payload} tới ${topic}`);
    res.json({ message: `Đã gửi lệnh điều khiển tới ${topic}`, payload });
  });
});

cron.schedule('* * * * *', () => {
  const now = new Date();
  const currentTime = now.toTimeString().slice(0, 5); // "HH:MM"
  const day = now.getDay(); // 0 = CN
  const currentDay = day === 0 ? 8 : day + 1;


  db.query(
    `SELECT s.*
    FROM irrigation_schedules s
    JOIN sections sec ON s.section_id = sec.id
    WHERE s.is_active = 1
    AND s.start_time = ?
    AND sec.mode = 'schedule'`,
    [currentTime],
    (err, results) => {
      if (err) return console.error('DB error:', err);

      results.forEach(schedule => {
        const days = (schedule.days_of_week || '').split(',');
        if (!days.includes(currentDay.toString())) return;

        const onPayload = JSON.stringify({ sectionId: schedule.section_id, action: 'ON' });
        mqttClient.publish('garden/command', onPayload);
        console.log(`[LỊCH] Bật bơm vùng ${schedule.section_id} (ngày ${currentDay})`);

        setTimeout(() => {
          const offPayload = JSON.stringify({ sectionId: schedule.section_id, action: 'OFF' });
          mqttClient.publish('garden/command', offPayload);
          console.log(`[LỊCH] Tắt bơm vùng ${schedule.section_id}`);

          db.query(
            "INSERT INTO irrigation_logs (section_id, duration, trigger_type) VALUES (?, ?, 'schedule')",
            [schedule.section_id, schedule.duration],
            (err) => {
              if (err) {
                console.error('Lỗi ghi log tưới:', err);
              } else {
                console.log(`[LOG] Ghi lịch sử tưới vùng ${schedule.section_id}`);
              }
            }
          );
        }, schedule.duration * 60 * 1000);
      });
    }
  );
});

cron.schedule('* * * * *', () => {
  db.query(
    `SELECT s.id AS section_id, t.sensor_type_id, t.on_threshold, t.off_threshold
     FROM sections s
     JOIN irrigation_thresholds t ON s.id = t.section_id
     WHERE s.mode = 'threshold'`,
    (err, sections) => {
      if (err) return console.error('DB error threshold:', err);

      sections.forEach(section => {
        const { section_id, sensor_type_id, on_threshold, off_threshold } = section;

        // Lấy dữ liệu cảm biến gần nhất
        db.query(
          `SELECT value FROM sensor_data
           WHERE section_id = ? AND sensor_type_id = ?
           ORDER BY created_at DESC LIMIT 1`,
          [section_id, sensor_type_id],
          (err, results) => {
            if (err || results.length === 0) return;

            const latestValue = results[0].value;
            const state = pumpStates[section_id];

            // BẬT BƠM nếu nhỏ hơn hoặc bằng ngưỡng bật
            if (latestValue <= on_threshold) {
              if (!state || !state.isOn) {
                mqttClient.publish('garden/command', JSON.stringify({
                  sectionId: section_id,
                  action: 'ON'
                }));
                console.log(`[THRESHOLD] Bật bơm vùng ${section_id} vì ${latestValue} ≤ ${on_threshold}`);

                pumpStates[section_id] = {
                  isOn: true,
                  startTime: Date.now()
                };
              }
            }

            // TẮT BƠM nếu lớn hơn hoặc bằng ngưỡng tắt
            else if (latestValue >= off_threshold) {
              if (state && state.isOn) {
                mqttClient.publish('garden/command', JSON.stringify({
                  sectionId: section_id,
                  action: 'OFF'
                }));
                console.log(`[THRESHOLD] Tắt bơm vùng ${section_id} vì ${latestValue} ≥ ${off_threshold}`);

                // Tính duration
                const durationMs = Date.now() - state.startTime;
                const durationMinutes = Math.round(durationMs / 1000 / 60);

                db.query(
                  `INSERT INTO irrigation_logs (section_id, duration, trigger_type)
                   VALUES (?, ?, 'threshold')`,
                  [section_id, durationMinutes],
                  (err) => {
                    if (err) console.error('Lỗi ghi log threshold:', err);
                    else console.log(`[LOG] Ghi log threshold vùng ${section_id} (${durationMinutes} phút)`);
                  }
                );

                // Reset trạng thái
                pumpStates[section_id] = { isOn: false };
              }
            }
          }
        );
      });
    }
  );
});

// --- Trang chủ - Hiển thị danh sách vùng tưới ---
router.get('/', (req, res) => {
    db.query('SELECT * FROM sections', (err1, sectionResults) => {
        if (err1) return res.send('Lỗi truy vấn vùng tưới.');
        db.query('SELECT * FROM sensor_types', (err2, sensorTypeResults) => {
            if (err2) return res.send('Lỗi truy vấn loại cảm biến.');
            res.render('index', {
                sections: sectionResults,
                sensorTypes: sensorTypeResults,
                error: null
            });
        });
    });
});

// --- Quản lý Vùng Tưới (Sections) ---
// Hiển thị form thêm vùng tưới
router.get('/sections/add', (req, res) => {
    res.render('section/add_section', { error: null });
});

// Xử lý thêm vùng tưới mới
router.post('/sections/add', (req, res) => {
    const { name, description } = req.body;
    const lowerCaseName = name.toLowerCase(); // Chuyển tên nhập vào thành chữ thường

    // Kiểm tra xem tên vùng (không phân biệt hoa thường) đã tồn tại chưa
    db.query('SELECT COUNT(*) AS count FROM sections WHERE LOWER(name) = ?', [lowerCaseName], (err, result) => {
        if (err) {
            console.error('Error checking existing section name (case-insensitive):', err);
            return res.redirect('/?error=Lỗi khi kiểm tra tên vùng.');
        }

        if (result[0].count > 0) {
            // Tên vùng đã tồn tại (không phân biệt hoa thường), hiển thị lỗi
            return res.redirect('/sections/add?error=Tên vùng đã tồn tại. Vui lòng chọn tên khác.');
        }

        // Nếu tên vùng chưa tồn tại, tiến hành thêm mới
        db.query('INSERT INTO sections (name, description) VALUES (?, ?)', [name, description], (err, result) => {
            if (err) {
                console.error('Error adding section:', err);
                return res.redirect('/?error=Lỗi khi thêm vùng tưới.');
            }
            res.redirect('/');
        });
    });
});

// Hiển thị form sửa vùng tưới
router.get('/sections/edit/:id', (req, res) => {
    const sectionId = req.params.id;
    db.query('SELECT * FROM sections WHERE id = ?', [sectionId], (err, results) => {
        if (err) {
            console.error('Error fetching section for edit:', err);
            return res.redirect('/?error=Lỗi khi tải thông tin vùng tưới để sửa.');
        }
        if (results.length > 0) {
            res.render('section/edit_section', { section: results[0] });
        } else {
            res.redirect('/');
        }
    });
});

// Xử lý cập nhật vùng tưới
router.post('/sections/edit/:id', (req, res) => {
    const sectionId = req.params.id;
    const { name, description } = req.body;
    db.query('UPDATE sections SET name = ?, description = ? WHERE id = ?', [name, description, sectionId], (err, result) => {
        if (err) {
            console.error('Error updating section:', err);
            return res.redirect('/?error=Lỗi khi cập nhật vùng tưới.');
        }
        res.redirect('/');
    });
});

// --- Cập nhật mode cho vùng tưới ---
router.post('/sections/:id/mode', (req, res) => {
    const sectionId = req.params.id;
    const { mode } = req.body;

    if (!['manual', 'threshold', 'schedule'].includes(mode)) {
        return res.redirect('/?error=Chế độ không hợp lệ');
    }

    db.query('UPDATE sections SET mode = ? WHERE id = ?', [mode, sectionId], (err) => {
        if (err) {
            console.error('Lỗi cập nhật mode:', err);
            return res.redirect('/?error=Lỗi khi cập nhật chế độ.');
        }
        res.redirect('/');
    });
});

// Xóa vùng tưới
router.get('/sections/delete/:id', (req, res) => {
    const sectionId = req.params.id;
    db.query('DELETE FROM sections WHERE id = ?', [sectionId], (err, result) => {
        if (err) {
            console.error('Error deleting section:', err);
            return res.redirect('/?error=Lỗi khi xóa vùng tưới.');
        }
        res.redirect('/');
    });
});

// --- Quản lý Cảm biến cho Vùng Tưới ---
// Hiển thị danh sách cảm biến đã gán và form thêm cảm biến
router.get('/sections/:id/sensors', (req, res) => {
    const sectionId = req.params.id;

    // Truy vấn tên vùng dựa trên sectionId
    db.query('SELECT name FROM sections WHERE id = ?', [sectionId], (err, sectionNameResult) => {
        if (err) {
            console.error('Error fetching section name:', err);
            return res.redirect('/?error=Lỗi khi tải tên vùng.');
        }

        // Nếu không tìm thấy tên vùng, trả về lỗi
        if (sectionNameResult.length === 0) {
            return res.redirect('/?error=Không tìm thấy vùng tưới.');
        }

        const sectionName = sectionNameResult[0].name; // Lấy tên vùng từ kết quả truy vấn

        // Truy vấn cảm biến đã được gán cho vùng tưới
        db.query('SELECT ss.id, st.name AS sensor_name, st.unit FROM section_sensors ss JOIN sensor_types st ON ss.sensor_type_id = st.id WHERE ss.section_id = ?', [sectionId], (err, assignedSensors) => {
            if (err) {
                console.error('Error fetching assigned sensors:', err);
                return res.redirect('/?error=Lỗi khi tải danh sách cảm biến của vùng.');
            }

            // Truy vấn tất cả loại cảm biến
            db.query('SELECT * FROM sensor_types', (err, allSensorTypes) => {
                if (err) {
                    console.error('Error fetching all sensor types:', err);
                    return res.redirect('/?error=Lỗi khi tải danh sách các loại cảm biến.');
                }

                // Render view với tên vùng và danh sách cảm biến
                res.render('section/section_sensors', { 
                    sectionId: sectionId, 
                    sectionName: sectionName,  // Truyền tên vùng vào view
                    assignedSensors: assignedSensors, 
                    allSensorTypes: allSensorTypes 
                });
            });
        });
    });
});


// Xử lý thêm cảm biến vào vùng tưới
router.post('/sections/:id/sensors/add', (req, res) => {
    const sectionId = req.params.id;
    const { sensorTypeId } = req.body;
    db.query('INSERT INTO section_sensors (section_id, sensor_type_id) VALUES (?, ?)', [sectionId, sensorTypeId], (err, result) => {
        if (err) {
            console.error('Error adding sensor to section:', err);
            return res.redirect(`/sections/${sectionId}/sensors?error=Lỗi khi thêm cảm biến vào vùng.`);
        }
        res.redirect(`/sections/${sectionId}/sensors`);
    });
});

// Xóa cảm biến khỏi vùng tưới
router.get('/sections/:sectionId/sensors/delete/:sensorId', (req, res) => {
    const { sectionId, sensorId } = req.params;
    db.query('DELETE FROM section_sensors WHERE id = ? AND section_id = ?', [sensorId, sectionId], (err, result) => {
        if (err) {
            console.error('Error deleting sensor from section:', err);
            return res.redirect(`/sections/${sectionId}/sensors?error=Lỗi khi xóa cảm biến khỏi vùng.`);
        }
        res.redirect(`/sections/${sectionId}/sensors`);
    });
});

// --- Quản lý Lịch trình Tưới (Schedules) ---
// Hiển thị danh sách lịch trình tưới của vùng
router.get('/sections/:id/schedules', (req, res) => {
    const sectionId = req.params.id;
    db.query('SELECT * FROM irrigation_schedules WHERE section_id = ?', [sectionId], (err, schedules) => {
        if (err) {
            console.error('Error fetching schedules:', err);
            return res.redirect('/?error=Lỗi khi tải lịch trình tưới.');
        }
        res.render('schedule/manage_schedules', { sectionId: sectionId, schedules: schedules });
    });
});

// Hiển thị form thêm lịch trình tưới
router.get('/sections/:id/schedules/add', (req, res) => {
    const sectionId = req.params.id;
    res.render('schedule/add_schedule', { sectionId: sectionId });
});

// Xử lý thêm lịch trình tưới mới
router.post('/sections/:id/schedules/add', (req, res) => {
    const sectionId = req.params.id;
    const { startTime, duration, repeatRule, daysOfWeek, isActive } = req.body;
    const days = Array.isArray(daysOfWeek) ? daysOfWeek.join(',') : daysOfWeek;
    db.query('INSERT INTO irrigation_schedules (section_id, start_time, duration, repeat_rule, days_of_week, is_active) VALUES (?, ?, ?, ?, ?, ?)',
        [sectionId, startTime, duration, repeatRule, days, isActive === 'on' ? 1 : 0], (err, result) => {
            if (err) {
                console.error('Error adding schedule:', err);
                return res.redirect(`/sections/${sectionId}/schedules/add?error=Lỗi khi thêm lịch trình.`);
            }
            res.redirect(`/sections/${sectionId}/schedules`);
        });
});

// Hiển thị form sửa lịch trình tưới
router.get('/sections/:sectionId/schedules/edit/:scheduleId', (req, res) => {
    const { sectionId, scheduleId } = req.params;
    db.query('SELECT * FROM irrigation_schedules WHERE id = ? AND section_id = ?', [scheduleId, sectionId], (err, results) => {
        if (err) {
            console.error('Error fetching schedule for edit:', err);
            return res.redirect(`/sections/${sectionId}/schedules?error=Lỗi khi tải lịch trình để sửa.`);
        }
        if (results.length > 0) {
            res.render('schedule/edit_schedule', { sectionId: sectionId, schedule: results[0] });
        } else {
            res.redirect(`/sections/${sectionId}/schedules`);
        }
    });
});

// Xử lý cập nhật lịch trình tưới
router.post('/sections/:sectionId/schedules/edit/:scheduleId', (req, res) => {
    const { sectionId, scheduleId } = req.params;
    const { startTime, duration, repeatRule, daysOfWeek, isActive } = req.body;
    const days = Array.isArray(daysOfWeek) ? daysOfWeek.join(',') : daysOfWeek;
    db.query('UPDATE irrigation_schedules SET start_time = ?, duration = ?, repeat_rule = ?, days_of_week = ?, is_active = ? WHERE id = ? AND section_id = ?',
        [startTime, duration, repeatRule, days, isActive === 'on' ? 1 : 0, scheduleId, sectionId], (err, result) => {
            if (err) {
                console.error('Error updating schedule:', err);
                return res.redirect(`/sections/${sectionId}/schedules?error=Lỗi khi cập nhật lịch trình.`);
            }
            res.redirect(`/sections/${sectionId}/schedules`);
        });
});

// Xóa lịch trình tưới
router.get('/sections/:sectionId/schedules/delete/:scheduleId', (req, res) => {
    const { sectionId, scheduleId } = req.params;
    db.query('DELETE FROM irrigation_schedules WHERE id = ? AND section_id = ?', [scheduleId, sectionId], (err, result) => {
        if (err) {
            console.error('Error deleting schedule:', err);
            return res.redirect(`/sections/${sectionId}/schedules?error=Lỗi khi xóa lịch trình.`);
        }
        res.redirect(`/sections/${sectionId}/schedules`);
    });
});

// --- Quản lý Ngưỡng Tưới Tự Động (Thresholds) ---

// Hiển thị danh sách ngưỡng tưới
router.get('/sections/:id/thresholds', (req, res) => {
  const sectionId = req.params.id;
  db.query(
    `SELECT it.id, st.name AS sensor_name, it.on_threshold, it.off_threshold
     FROM irrigation_thresholds it
     JOIN sensor_types st ON it.sensor_type_id = st.id
     WHERE it.section_id = ?`,
    [sectionId],
    (err, thresholds) => {
      if (err) {
        console.error('Error fetching thresholds:', err);
        return res.redirect('/?error=Lỗi khi tải ngưỡng tưới.');
      }
      db.query(
        `SELECT ss.sensor_type_id, st.name
         FROM section_sensors ss
         JOIN sensor_types st ON ss.sensor_type_id = st.id
         WHERE ss.section_id = ?`,
        [sectionId],
        (err, availableSensors) => {
          if (err) {
            console.error('Error fetching available sensors:', err);
            return res.redirect(`/sections/${sectionId}/thresholds?error=Lỗi khi tải danh sách cảm biến.`);
          }
          res.render('threshold/manage_thresholds', {
            sectionId,
            thresholds,
            availableSensors,
          });
        }
      );
    }
  );
});

// Hiển thị form thêm ngưỡng
router.get('/sections/:id/thresholds/add', (req, res) => {
  const sectionId = req.params.id;
  db.query(
    `SELECT ss.sensor_type_id, st.name
     FROM section_sensors ss
     JOIN sensor_types st ON ss.sensor_type_id = st.id
     WHERE ss.section_id = ?`,
    [sectionId],
    (err, availableSensors) => {
      if (err) {
        console.error('Error loading sensors:', err);
        return res.redirect(`/sections/${sectionId}/thresholds?error=Lỗi khi tải cảm biến.`);
      }
      res.render('threshold/add_threshold', { sectionId, availableSensors });
    }
  );
});

// Xử lý thêm ngưỡng
router.post('/sections/:id/thresholds/add', (req, res) => {
  const sectionId = req.params.id;
  const { sensorTypeId, onThreshold, offThreshold } = req.body;

  db.query(
    `INSERT INTO irrigation_thresholds (section_id, sensor_type_id, on_threshold, off_threshold)
     VALUES (?, ?, ?, ?)`,
    [sectionId, sensorTypeId, onThreshold, offThreshold],
    (err, result) => {
      if (err) {
        console.error('Insert error:', err);
        return res.send('Ngưỡng cho cảm biến đã tồn tại hoặc lỗi thêm.');
      }
      res.redirect(`/sections/${sectionId}/thresholds`);
    }
  );
});

// Hiển thị form sửa ngưỡng
router.get('/sections/:sectionId/thresholds/edit/:thresholdId', (req, res) => {
  const { sectionId, thresholdId } = req.params;
  db.query(
    'SELECT * FROM irrigation_thresholds WHERE id = ? AND section_id = ?',
    [thresholdId, sectionId],
    (err, threshold) => {
      if (err || threshold.length === 0) {
        console.error('Error loading threshold:', err);
        return res.redirect(`/sections/${sectionId}/thresholds?error=Không tìm thấy ngưỡng.`);
      }

      db.query(
        `SELECT ss.sensor_type_id, st.name
         FROM section_sensors ss
         JOIN sensor_types st ON ss.sensor_type_id = st.id
         WHERE ss.section_id = ?`,
        [sectionId],
        (err, availableSensors) => {
          if (err) {
            console.error('Error loading sensors:', err);
            return res.redirect(`/sections/${sectionId}/thresholds?error=Lỗi tải cảm biến.`);
          }
          res.render('threshold/edit_threshold', {
            sectionId,
            threshold: threshold[0],
            availableSensors,
          });
        }
      );
    }
  );
});

// Xử lý cập nhật ngưỡng
router.post('/sections/:sectionId/thresholds/edit/:thresholdId', (req, res) => {
  const { sectionId, thresholdId } = req.params;
  const { sensorTypeId, onThreshold, offThreshold } = req.body;

  db.query(
    `UPDATE irrigation_thresholds
     SET sensor_type_id = ?, on_threshold = ?, off_threshold = ?
     WHERE id = ? AND section_id = ?`,
    [sensorTypeId, onThreshold, offThreshold, thresholdId, sectionId],
    (err, result) => {
      if (err) {
        console.error('Update error:', err);
        return res.redirect(`/sections/${sectionId}/thresholds?error=Lỗi khi cập nhật ngưỡng.`);
      }
      res.redirect(`/sections/${sectionId}/thresholds`);
    }
  );
});

// Xóa ngưỡng
router.get('/sections/:sectionId/thresholds/delete/:thresholdId', (req, res) => {
  const { sectionId, thresholdId } = req.params;
  db.query(
    'DELETE FROM irrigation_thresholds WHERE id = ? AND section_id = ?',
    [thresholdId, sectionId],
    (err, result) => {
      if (err) {
        console.error('Delete error:', err);
        return res.redirect(`/sections/${sectionId}/thresholds?error=Lỗi khi xóa ngưỡng.`);
      }
      res.redirect(`/sections/${sectionId}/thresholds`);
    }
  );
});

module.exports = router;


// --- Hiển thị Log Lịch Sử Tưới ---
router.get('/logs', (req, res) => {
    db.query('SELECT il.id, s.name AS section_name, il.start_time, il.duration, il.trigger_type, il.created_at FROM irrigation_logs il JOIN sections s ON il.section_id = s.id ORDER BY il.created_at DESC', (err, logs) => {
        if (err) {
            console.error('Error fetching logs:', err);
            return res.render('logs', { logs: [], error: 'Lỗi khi tải lịch sử tưới.' });
        }
        res.render('logs', { logs: logs, error: null });
    });
});

// Hiển thị form thêm mới loại cảm biến
router.get('/sensor-types/add', (req, res) => {
    res.render('sensor/add_sensor', { error: null });
});

// Xử lí thêm loại cảm biến
router.post('/sensor-types/add', (req, res) => {
    const { name, unit } = req.body;
    const lowerCaseName = name.toLowerCase(); // Chuyển tên thành chữ thường để kiểm tra

    // Kiểm tra xem tên loại cảm biến (không phân biệt hoa thường) đã tồn tại chưa
    const checkQuery = 'SELECT COUNT(*) AS count FROM sensor_types WHERE LOWER(name) = ?';
    db.query(checkQuery, [lowerCaseName], (err, result) => {
        if (err) {
            console.error('Lỗi khi kiểm tra tên loại cảm biến:', err);
            return res.send('Lỗi khi kiểm tra tên loại cảm biến.');
        }

        if (result[0].count > 0) {
            return res.send('Tên loại cảm biến đã tồn tại (không phân biệt hoa thường).');
        }

        // Nếu tên chưa tồn tại, tiến hành thêm mới
        const insertQuery = 'INSERT INTO sensor_types (name, unit) VALUES (?, ?)';
        db.query(insertQuery, [name, unit], (err, insertResult) => {
            if (err) {
                console.error('Lỗi thêm loại cảm biến:', err);
                return res.send('Lỗi thêm loại cảm biến.');
            }
            res.redirect('/sensor-types/add');
        });
    });
});

// Hiển thị form sửa loại cảm biến
router.get('/sensor-types/edit/:id', (req, res) => {
    const sensorTypeId = req.params.id;
    const query = 'SELECT * FROM sensor_types WHERE id = ?';

    db.query(query, [sensorTypeId], (err, results) => {
        if (err) {
            console.error('Error fetching sensor type for edit:', err);
            return res.redirect('/sensor-types?error=Lỗi khi tải thông tin loại cảm biến để sửa.');
        }

        if (results.length > 0) {
            res.render('sensor/edit_sensor', { sensorType: results[0], error: null });
        } else {
            res.redirect('/sensor-types');
        }
    });
});

// Xử lý cập nhật loại cảm biến
router.post('/sensor-types/edit/:id', (req, res) => {
    const { name, unit } = req.body;
    const id = req.params.id;

    // Kiểm tra tên loại cảm biến đã tồn tại chưa
    const checkQuery = 'SELECT * FROM sensor_types WHERE name = ? AND id != ?';
    db.query(checkQuery, [name, id], (err, results) => {
        if (err) {
            console.error('Error checking for duplicate sensor type name:', err);
            return res.send('Lỗi kiểm tra trùng tên loại cảm biến.');
        }

        if (results.length > 0) {
            // Nếu có kết quả, nghĩa là tên đã tồn tại
            return res.render('edit_sensor', {
                sensorType: { id, name, unit },
                error: 'Tên loại cảm biến đã tồn tại.'
            });
        }

        // Nếu không trùng tên, thực hiện cập nhật
        const query = 'UPDATE sensor_types SET name = ?, unit = ? WHERE id = ?';
        db.query(query, [name, unit, id], (err, result) => {
            if (err) {
                console.error('Error updating sensor type:', err);
                return res.send('Lỗi cập nhật loại cảm biến.');
            }
            res.redirect('/');
        });
    });
});

//  Xử lí xóa loại cảm biến
router.get('/sensor-types/delete/:id', (req, res) => {
    const id = req.params.id;
    db.query('DELETE FROM sensor_types WHERE id = ?', [id], (err, result) => {
        if (err) return res.send('Lỗi xóa loại cảm biến.');
        res.redirect('/');
    });
});


module.exports = router;