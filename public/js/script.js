function showTab(tabId) {
    // Ẩn tất cả các tab
    const tabs = document.querySelectorAll('.tab-content');
    tabs.forEach(tab => tab.classList.remove('active'));

    // Xóa lớp 'active' ở tất cả các nút tab
    const tabButtons = document.querySelectorAll('.tab-btn');
    tabButtons.forEach(button => button.classList.remove('active'));

    // Hiển thị tab hiện tại
    document.getElementById(tabId).classList.add('active');

    // Thêm lớp 'active' vào nút tab đã được chọn
    const activeButton = Array.from(tabButtons).find(button => button.textContent === tabId.split('-')[0]);
    if (activeButton) activeButton.classList.add('active');
}


document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('select[name="mode"]').forEach(select => {
    const sectionId = select.dataset.sectionId;
    const toggleDiv = document.getElementById(`manual-control-${sectionId}`);

    // Hiển thị toggle nếu chế độ là 'manual'
    if (select.value === 'manual') {
      toggleDiv.style.display = 'block';
    }

    // Bắt sự kiện thay đổi chế độ
    select.addEventListener('change', () => {
      toggleDiv.style.display = select.value === 'manual' ? 'block' : 'none';
    });
  });
});

function togglePump(sectionId, state) {
  fetch(`/toggle-pump/${sectionId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: state ? 'ON' : 'OFF' })
  })
  .then(async res => {
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || 'Gửi lệnh thất bại');
    }
    alert(data.message || 'Lệnh đã gửi thành công');
  })
  .catch(err => {
    console.error('Pump command error:', err);
    alert('Lỗi khi gửi lệnh đến thiết bị: ' + err.message);
  });
}



document.addEventListener('DOMContentLoaded', () => {
    // Mặc định hiển thị tab đầu tiên
    showTab('sections-tab');
});
