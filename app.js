document.getElementById('year').textContent = new Date().getFullYear();

const form = document.getElementById('requestForm');
const result = document.getElementById('result');
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  result.style.display = 'block';
  result.textContent = 'جارٍ إرسال الطلب بأمان…';
  const payload = {
    fullName: document.getElementById('fullName').value.trim(),
    phone: document.getElementById('phone').value.trim(),
    email: document.getElementById('email').value.trim(),
    nationality: document.getElementById('nationality').value,
    serviceType: document.getElementById('serviceType').value,
    passportValidity: document.getElementById('passportValidity').value,
    details: document.getElementById('details').value.trim(),
    consent: document.getElementById('consent').checked
  };
  try {
    const response = await fetch('/api/requests', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(payload)
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'تعذر إرسال الطلب.');
    result.textContent = `${data.message} رقم المتابعة: ${data.reference}`;
    form.reset();
  } catch (error) {
    result.textContent = error.message || 'تعذر الاتصال بالخادم. حاول لاحقًا.';
  }
});