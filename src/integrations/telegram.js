const log = require("../utils/logger");

const TAG = "TELEGRAM";

class TelegramBot {
  constructor({
    token = "",
    chatId = "",
    allowFirstChat = false,
    pollIntervalMs = 3000,
  } = {}) {
    this.token = token;
    this.chatId = chatId ? String(chatId) : "";
    this.allowFirstChat = !!allowFirstChat;
    this.pollIntervalMs = pollIntervalMs;
    this.enabled = !!token;
    this.offset = 0;
    this.timer = null;
    this.onCommand = null;
    this.rejectedChats = new Set();
  }

  apiUrl(method) {
    return `https://api.telegram.org/bot${this.token}/${method}`;
  }

  async request(method, payload = {}) {
    const res = await fetch(this.apiUrl(method), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok || data.ok === false) {
      const desc = data?.description || `HTTP ${res.status}`;
      throw new Error(`Telegram ${method} failed: ${desc}`);
    }
    return data;
  }

  async sendMessage(text) {
    if (!this.enabled || !this.chatId) return false;
    try {
      await this.request("sendMessage", {
        chat_id: this.chatId,
        text,
        disable_web_page_preview: true,
      });
      return true;
    } catch (err) {
      log.warn(TAG, `sendMessage failed: ${err.message}`);
      return false;
    }
  }

  async primeOffset() {
    if (!this.enabled) return;
    try {
      const data = await this.request("getUpdates", {
        timeout: 0,
        limit: 100,
        allowed_updates: ["message"],
      });
      const updates = Array.isArray(data.result) ? data.result : [];
      if (updates.length === 0) return;
      const last = updates[updates.length - 1];
      this.offset = Number(last.update_id) + 1;
    } catch (err) {
      log.warn(TAG, `primeOffset failed: ${err.message}`);
    }
  }

  async handleUpdate(update) {
    const msg = update?.message;
    const text = typeof msg?.text === "string" ? msg.text.trim() : "";
    if (!text) return;

    const incomingChatId = String(msg?.chat?.id || "");
    if (!incomingChatId) return;

    if (!this.chatId) {
      if (this.allowFirstChat) {
        this.chatId = incomingChatId;
        log.warn(TAG, `Bound to first chat id ${this.chatId}`);
        await this.sendMessage("Bot linked to this chat. Use /help for commands.");
      } else {
        return;
      }
    }

    if (incomingChatId !== this.chatId) {
      if (!this.rejectedChats.has(incomingChatId)) {
        this.rejectedChats.add(incomingChatId);
        log.warn(TAG, `Rejected command from unauthorized chat ${incomingChatId}`);
      }
      return;
    }

    if (!text.startsWith("/")) return;
    const [rawCommand, ...args] = text.split(/\s+/);
    const command = rawCommand.toLowerCase();

    if (this.onCommand) {
      await this.onCommand({
        command,
        args,
        text,
        chatId: incomingChatId,
      });
    }
  }

  async pollOnce() {
    if (!this.enabled) return;

    try {
      const data = await this.request("getUpdates", {
        offset: this.offset || undefined,
        timeout: 0,
        limit: 20,
        allowed_updates: ["message"],
      });
      const updates = Array.isArray(data.result) ? data.result : [];
      for (const update of updates) {
        this.offset = Math.max(this.offset, Number(update.update_id) + 1);
        await this.handleUpdate(update);
      }
    } catch (err) {
      log.warn(TAG, `pollOnce failed: ${err.message}`);
    }
  }

  async startPolling(onCommand) {
    if (!this.enabled) return;
    this.onCommand = onCommand;
    await this.primeOffset();
    this.timer = setInterval(() => {
      this.pollOnce().catch((err) => log.warn(TAG, `poll timer error: ${err.message}`));
    }, this.pollIntervalMs);
    log.info(TAG, "Polling started");
  }

  stopPolling() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

module.exports = TelegramBot;
