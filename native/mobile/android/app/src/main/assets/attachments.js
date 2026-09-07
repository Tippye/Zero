(() => {
  if (window !== window.top || !window.ZeroAttachments || window.__zeroAttachmentsReady) return;
  window.__zeroAttachmentsReady = true;
  const objects = new Map();
  const create = URL.createObjectURL.bind(URL);
  const revoke = URL.revokeObjectURL.bind(URL);
  URL.createObjectURL = (blob) => {
    const url = create(blob);
    objects.set(url, blob);
    return url;
  };
  URL.revokeObjectURL = (url) => {
    objects.delete(url);
    revoke(url);
  };
  let pending,
    busy = false;
  ZeroAttachments.onmessage = ({ data }) => {
    try {
      const message = JSON.parse(data);
      if (pending?.id === message.id) {
        const current = pending;
        pending = null;
        clearTimeout(current.timer);
        message.error ? current.reject(new Error(message.error)) : current.resolve();
      }
    } catch {
      /* Ignore unrelated messages. */
    }
  };
  function send(message) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending = null;
        reject(new Error('附件传输超时，请重试。'));
      }, 15000);
      pending = { id: message.id, resolve, reject, timer };
      ZeroAttachments.postMessage(JSON.stringify(message));
    });
  }
  function base64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1]);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }
  async function save(url, name) {
    if (busy) return;
    busy = true;
    const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
      byte.toString(16).padStart(2, '0'),
    ).join('');
    try {
      // Capture the Blob before the web client revokes its URL after .click().
      const blob = objects.get(url) || (await (await fetch(url)).blob());
      if (blob.size > 25 * 1024 * 1024) throw new Error('附件不能超过 25 MB。');
      await send({
        type: 'start',
        id,
        name: name || 'attachment',
        mime: blob.type,
        size: blob.size,
      });
      for (let offset = 0, seq = 0; offset < blob.size; offset += 65536, seq++) {
        await send({
          type: 'chunk',
          id,
          seq,
          data: await base64(blob.slice(offset, offset + 65536)),
        });
      }
      await send({ type: 'finish', id });
    } catch (error) {
      ZeroAttachments.postMessage(JSON.stringify({ type: 'abort', id }));
      // eslint-disable-next-line no-alert -- MainActivity renders this through its native error dialog.
      alert(error.message || '附件保存失败，请重试。');
    } finally {
      busy = false;
    }
  }
  const downloadable = (url) => url.startsWith('blob:') || url.startsWith('data:');
  document.addEventListener(
    'click',
    (event) => {
      const anchor = event.target.closest?.('a');
      if (!anchor || !anchor.hasAttribute('download') || !downloadable(anchor.href)) return;
      event.preventDefault();
      void save(anchor.href, anchor.download);
    },
    true,
  );
  const open = window.open.bind(window);
  window.open = (url, ...args) => {
    if (typeof url === 'string' && downloadable(url)) {
      void save(url, 'attachment').finally(() => URL.revokeObjectURL(url));
      return null;
    }
    return open(url, ...args);
  };
})();
