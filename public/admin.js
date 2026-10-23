const loginPanel = document.getElementById('loginPanel');
const dashboard = document.getElementById('dashboard');
const loginMsg = document.getElementById('loginMsg');
const dashMsg = document.getElementById('dashMsg');
const rows = document.getElementById('rows');
const statusOptions = ['جديد','قيد المراجعة','بانتظار العميل','مكتمل','مغلق'];

function showMessage(el, text) { el.textContent = text; el.classList.remove('hidden'); }
async function api(url, options = {}) {
  const response = await fetch(url, { credentials: 'same-origin', ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'حدث خطأ.');
  return data;
}
function textCell(text) {
  const td = document.createElement('td');
  td.textContent = text || '—';
  return td;
}
function whatsappLink(phone, reference) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return null;
  const a = document.createElement('a');
  a.href = `https://wa.me/${digits}?text=${encodeURIComponent('مرحبًا، بخصوص طلب الخدمة رقم ' + reference + ' من خدمات تأشيرات عُمان.')}`;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.textContent = 'فتح واتساب';
  return a;
}
async function loadRequests() {
  dashMsg.classList.add('hidden');
  try {
    const data = await api('/api/admin/requests');
    rows.replaceChildren();
    for (const item of data.requests) {
      const tr = document.createElement('tr');
      tr.append(textCell(item.reference));
      tr.append(textCell(new Date(item.created_at).toLocaleString('ar')));
      const contact = document.createElement('td');
      const name = document.createElement('strong'); name.textContent = item.full_name;
      const phone = document.createElement('div'); phone.textContent = item.phone;
      const email = document.createElement('div'); email.textContent = item.email || '';
      contact.append(name, phone, email); tr.append(contact);
      tr.append(textCell(item.service_type));
      tr.append(textCell([item.nationality, item.passport_validity, item.details].filter(Boolean).join(' — ')));
      const statusCell = document.createElement('td');
      const select = document.createElement('select');
      for (const status of statusOptions) {
        const option = document.createElement('option'); option.value = status; option.textContent = status;
        select.append(option);
      }
      select.value = item.status;
      select.addEventListener('change', async () => {
        select.disabled = true;
        try {
          await api(`/api/admin/requests/${item.id}/status`, { method: 'PATCH', body: JSON.stringify({ status: select.value }) });
          showMessage(dashMsg, 'تم تحديث حالة الطلب ' + item.reference + '.');
        } catch (e) {
          showMessage(dashMsg, e.message);
          select.value = item.status;
        } finally { select.disabled = false; }
      });
      statusCell.append(select); tr.append(statusCell);
      const waCell = document.createElement('td');
      const link = whatsappLink(item.phone, item.reference);
      if (link) waCell.append(link); else waCell.textContent = 'لا يوجد رقم';
      tr.append(waCell);
      rows.append(tr);
    }
    if (!data.requests.length) showMessage(dashMsg, 'لا توجد طلبات حتى الآن.');
  } catch (e) {
    showMessage(dashMsg, e.message);
    if (e.message.includes('تسجيل الدخول')) {
      dashboard.classList.add('hidden'); loginPanel.classList.remove('hidden');
    }
  }
}
function enterDashboard() {
  loginPanel.classList.add('hidden'); dashboard.classList.remove('hidden'); loadRequests();
}
document.getElementById('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault(); loginMsg.classList.add('hidden');
  try {
    await api('/api/admin/login', { method: 'POST', body: JSON.stringify({
      username: document.getElementById('username').value,
      password: document.getElementById('password').value
    }) });
    document.getElementById('password').value = '';
    enterDashboard();
  } catch (err) { showMessage(loginMsg, err.message); }
});
document.getElementById('refreshBtn').addEventListener('click', loadRequests);
document.getElementById('logoutBtn').addEventListener('click', async () => {
  try { await api('/api/admin/logout', { method: 'POST', body: '{}' }); } catch {}
  dashboard.classList.add('hidden'); loginPanel.classList.remove('hidden');
});
api('/api/admin/me').then(enterDashboard).catch(() => {});
