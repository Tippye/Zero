const result = document.querySelector('#result');
async function refresh() {
  const config = await window.zeroSettings.read();
  for (const key of [
    'server',
    'allowHttp',
    'notifications',
    'preview',
    'closeToTray',
    'launchAtLogin',
  ]) {
    const el = document.getElementById(key);
    if (el.type === 'checkbox') el.checked = config[key];
    else el.value = config[key];
  }
  document.querySelector('#status').textContent =
    `v${config.version} · 系统通知：${config.notificationsSupported ? '支持' : '不可用'} · 当前默认邮件应用：${config.defaultMail ? 'Zero Mail' : '其他应用'}`;
}
async function run(action) {
  try {
    result.textContent = '处理中…';
    await action();
    result.textContent = '已完成 / Done';
  } catch (error) {
    result.textContent = error.message;
  }
}
document.querySelector('#settings').addEventListener('submit', (event) => {
  event.preventDefault();
  void run(async () => {
    const data = {};
    for (const key of [
      'server',
      'allowHttp',
      'notifications',
      'preview',
      'closeToTray',
      'launchAtLogin',
    ]) {
      const el = document.getElementById(key);
      data[key] = el.type === 'checkbox' ? el.checked : el.value;
    }
    await window.zeroSettings.save(data);
  });
});
document
  .querySelector('#notification')
  .addEventListener('click', () => void run(() => window.zeroSettings.testNotification()));
document
  .querySelector('#defaults')
  .addEventListener('click', () => void run(() => window.zeroSettings.openDefaults()));
window.addEventListener('focus', () => void refresh());
void refresh();
