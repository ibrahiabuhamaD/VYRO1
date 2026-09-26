const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const storePath = path.join(__dirname, "wasl-data.json");
const defaultSettings = {
  siteName: "وَصْل",
  tagline: "محادثة تبدأ بلحظة",
  announcement: "",
  maintenance: false,
  matchingEnabled: true,
  registrationsEnabled: true,
  allowGuestAccess: true
};

let data = {
  settings: { ...defaultSettings },
  credentials: null,
  users: [],
  reports: [],
  moderationLog: []
};
let writeQueue = Promise.resolve();

function getStore() {
  return data;
}

async function persist() {
  const snapshot = JSON.stringify(data, null, 2);
  writeQueue = writeQueue.then(async () => {
    const temporaryPath = `${storePath}.${randomUUID()}.tmp`;
    await fs.writeFile(temporaryPath, snapshot, { encoding: "utf8", mode: 0o600 });
    await fs.rename(temporaryPath, storePath);
  });
  return writeQueue;
}

async function initialize() {
  let loadedFromDisk = false;
  try {
    const saved = JSON.parse(await fs.readFile(storePath, "utf8"));
    data = {
      ...data,
      ...saved,
      settings: { ...defaultSettings, ...(saved.settings || {}) },
      users: Array.isArray(saved.users) ? saved.users : [],
      reports: Array.isArray(saved.reports) ? saved.reports : [],
      moderationLog: Array.isArray(saved.moderationLog) ? saved.moderationLog : []
    };
    loadedFromDisk = true;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  if (!data.credentials && process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD_HASH) {
    const [salt, hash] = process.env.ADMIN_PASSWORD_HASH.split(":");
    if (/^[a-f0-9]{32}$/i.test(salt || "") && /^[a-f0-9]{64}$/i.test(hash || "")) {
      data.credentials = { email: process.env.ADMIN_EMAIL.trim().toLowerCase(), salt, hash };
    }
  }
  if (!loadedFromDisk || !data.credentials) await persist();
}

module.exports = { defaultSettings, getStore, initialize, persist };