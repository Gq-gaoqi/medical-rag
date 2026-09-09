import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
var __filename = fileURLToPath(import.meta.url);
var __dirname = path.dirname(__filename);
// 数据库文件路径
var dbPath = path.join(__dirname, '..', 'data', 'chat.db');
// 确保 data 目录存在
import fs from 'fs';
var dataDir = path.dirname(dbPath);
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}
// 创建数据库连接
var db = new Database(dbPath);
// 启用 WAL 模式以提高性能
db.pragma('journal_mode = WAL');
// 初始化数据库表
db.exec("\n  -- \u4F1A\u8BDD\u8868\n  CREATE TABLE IF NOT EXISTS sessions (\n    id TEXT PRIMARY KEY,\n    title TEXT NOT NULL,\n    model TEXT NOT NULL,\n    sdk_session_id TEXT,\n    created_at TEXT NOT NULL,\n    updated_at TEXT NOT NULL\n  );\n\n  -- \u6D88\u606F\u8868\n  CREATE TABLE IF NOT EXISTS messages (\n    id TEXT PRIMARY KEY,\n    session_id TEXT NOT NULL,\n    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),\n    content TEXT NOT NULL,\n    model TEXT,\n    created_at TEXT NOT NULL,\n    tool_calls TEXT,\n    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE\n  );\n\n  -- \u4E3A\u4F1A\u8BDD ID \u521B\u5EFA\u7D22\u5F15\n  CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id);\n");
// 数据库迁移：添加 sdk_session_id 列（如果不存在）
try {
    var tableInfo = db.prepare("PRAGMA table_info(sessions)").all();
    var hasColumn = tableInfo.some(function (col) { return col.name === 'sdk_session_id'; });
    if (!hasColumn) {
        db.exec("ALTER TABLE sessions ADD COLUMN sdk_session_id TEXT");
        console.log("[DB] Added sdk_session_id column to sessions table");
    }
}
catch (e) {
    // 忽略错误（列可能已存在）
}
// ============= 会话操作 =============
// 获取所有会话
export function getAllSessions() {
    var stmt = db.prepare('SELECT * FROM sessions ORDER BY updated_at DESC');
    return stmt.all();
}
// 获取单个会话
export function getSession(id) {
    var stmt = db.prepare('SELECT * FROM sessions WHERE id = ?');
    return stmt.get(id);
}
// 创建会话
export function createSession(session) {
    var stmt = db.prepare("\n    INSERT INTO sessions (id, title, model, sdk_session_id, created_at, updated_at)\n    VALUES (?, ?, ?, ?, ?, ?)\n  ");
    stmt.run(session.id, session.title, session.model, session.sdk_session_id, session.created_at, session.updated_at);
    return session;
}
// 更新会话
export function updateSession(id, updates) {
    var fields = [];
    var values = [];
    if (updates.title !== undefined) {
        fields.push('title = ?');
        values.push(updates.title);
    }
    if (updates.model !== undefined) {
        fields.push('model = ?');
        values.push(updates.model);
    }
    if (updates.sdk_session_id !== undefined) {
        fields.push('sdk_session_id = ?');
        values.push(updates.sdk_session_id);
    }
    if (fields.length === 0)
        return false;
    fields.push('updated_at = ?');
    values.push(new Date().toISOString());
    values.push(id);
    var stmt = db.prepare("UPDATE sessions SET ".concat(fields.join(', '), " WHERE id = ?"));
    var result = stmt.run.apply(stmt, values);
    return result.changes > 0;
}
// 删除会话
export function deleteSession(id) {
    var stmt = db.prepare('DELETE FROM sessions WHERE id = ?');
    var result = stmt.run(id);
    return result.changes > 0;
}
// ============= 消息操作 =============
// 获取会话的所有消息
export function getMessagesBySession(sessionId) {
    var stmt = db.prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC');
    return stmt.all(sessionId);
}
// 创建消息
export function createMessage(message) {
    var stmt = db.prepare("\n    INSERT INTO messages (id, session_id, role, content, model, created_at, tool_calls)\n    VALUES (?, ?, ?, ?, ?, ?, ?)\n  ");
    stmt.run(message.id, message.session_id, message.role, message.content, message.model, message.created_at, message.tool_calls);
    // 更新会话的 updated_at
    var updateStmt = db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?');
    updateStmt.run(new Date().toISOString(), message.session_id);
    return message;
}
// 更新消息内容
export function updateMessage(id, updates) {
    var fields = [];
    var values = [];
    if (updates.content !== undefined) {
        fields.push('content = ?');
        values.push(updates.content);
    }
    if (updates.tool_calls !== undefined) {
        fields.push('tool_calls = ?');
        values.push(updates.tool_calls);
    }
    if (fields.length === 0)
        return false;
    values.push(id);
    var stmt = db.prepare("UPDATE messages SET ".concat(fields.join(', '), " WHERE id = ?"));
    var result = stmt.run.apply(stmt, values);
    return result.changes > 0;
}
// 删除消息
export function deleteMessage(id) {
    var stmt = db.prepare('DELETE FROM messages WHERE id = ?');
    var result = stmt.run(id);
    return result.changes > 0;
}
// 批量创建消息（用于保存对话）
export function createMessages(messages) {
    var stmt = db.prepare("\n    INSERT INTO messages (id, session_id, role, content, model, created_at, tool_calls)\n    VALUES (?, ?, ?, ?, ?, ?, ?)\n  ");
    var insertMany = db.transaction(function (msgs) {
        for (var _i = 0, msgs_1 = msgs; _i < msgs_1.length; _i++) {
            var msg = msgs_1[_i];
            stmt.run(msg.id, msg.session_id, msg.role, msg.content, msg.model, msg.created_at, msg.tool_calls);
        }
    });
    insertMany(messages);
}
// 清空所有数据
export function clearAllData() {
    db.exec('DELETE FROM messages');
    db.exec('DELETE FROM sessions');
}
export default db;
