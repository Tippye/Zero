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
      let stored = this.identity ? await this.load(this.identity) : null;
      let page = await this.fetchFeed(stored?.cursor);
      if (this.identity !== page.owner) {
        this.identity = page.owner;
        stored = await this.load(page.owner);
        if (stored) {
          page = await this.fetchFeed(stored.cursor);
          if (page.owner !== this.identity) return;
        }
      }
      if (!stored) {
        await this.save(page.owner, { cursor: page.cursor, seen: [] });
        return;
      }
      const seen = new Set(stored.seen || []);
      for (const event of page.events) {
        if (seen.has(event.id)) continue;
        await this.show(event);
        seen.add(event.id);
      }
      await this.save(page.owner, { cursor: page.cursor, seen: [...seen].slice(-100) });
    } finally {
      this.running = false;
    }
  }
}
module.exports = { NotificationFeed };
