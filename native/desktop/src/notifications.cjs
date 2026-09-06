// Separate from Electron so polling, deduplication and session changes are testable.
class NotificationFeed {
  constructor({ fetchFeed, show, load, save }) {
    Object.assign(this, { fetchFeed, show, load, save });
    this.running = false;
    this.identity = null;
  }
  async poll() {
    if (this.running) return;
    this.running = true;
    try {
      const head = await this.fetchFeed();
      if (this.identity !== head.owner) {
        this.identity = head.owner;
      }
      const stored = await this.load(head.owner);
      if (!stored) {
        await this.save(head.owner, { cursor: head.cursor, seen: [] });
        return;
      }
      const page = await this.fetchFeed(stored.cursor);
      if (page.owner !== head.owner) return;
      const seen = new Set(stored.seen || []);
      for (const event of page.events) {
        if (seen.has(event.id)) continue;
        await this.show(event);
        seen.add(event.id);
      }
      await this.save(head.owner, { cursor: page.cursor, seen: [...seen].slice(-100) });
    } finally {
      this.running = false;
    }
  }
}
module.exports = { NotificationFeed };
