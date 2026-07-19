// One-time cleanup of already-stored noise rows, mirroring the new ingest rules:
// - MESSAGE_EDIT protocol rows: apply edited text onto the original message, else keep as real message
// - other protocolMessage rows: delete (sync/key-share plumbing)
// - stub-only 'unknown' rows: keep REVOKE/ADMIN_REVOKE as 'deleted' markers, delete the rest
// Run: npx tsx scripts/cleanup-noise.ts
import Database from 'better-sqlite3';

const db = new Database('./whatsapp.db');
db.pragma('journal_mode = WAL');

function extractText(message: Record<string, any> | null | undefined): string | null {
  if (!message) return null;
  return (
    message.conversation ||
    message.extendedTextMessage?.text ||
    message.imageMessage?.caption ||
    message.videoMessage?.caption ||
    message.documentMessage?.caption ||
    message.documentMessage?.fileName ||
    null
  );
}

function messageTypeOf(message: Record<string, any> | null | undefined): string {
  if (!message) return 'unknown';
  const keys = Object.keys(message).filter(
    (k) => k !== 'messageContextInfo' && k !== 'senderKeyDistributionMessage'
  );
  return keys[0] ?? 'unknown';
}

let editsApplied = 0;
let editsKept = 0;
let editsDropped = 0;

const editRows = db
  .prepare(`SELECT id, raw_json FROM messages WHERE message_type = 'protocolMessage'`)
  .all() as { id: string; raw_json: string }[];

const applyEdit = db.prepare(`UPDATE messages SET message_text = ? WHERE id = ?`);
const deleteRow = db.prepare(`DELETE FROM messages WHERE id = ?`);
const convertRow = db.prepare(
  `UPDATE messages SET message_text = ?, message_type = ? WHERE id = ?`
);

db.transaction(() => {
  for (const row of editRows) {
    const raw = JSON.parse(row.raw_json);
    const pm = raw?.message?.protocolMessage;
    if (pm?.type !== 'MESSAGE_EDIT' && pm?.type !== 14) {
      deleteRow.run(row.id);
      continue;
    }
    const targetId = pm.key?.id;
    const editedText = extractText(pm.editedMessage);
    if (targetId && editedText != null && applyEdit.run(editedText, targetId).changes > 0) {
      deleteRow.run(row.id);
      editsApplied++;
    } else if (editedText != null) {
      convertRow.run(editedText, messageTypeOf(pm.editedMessage), row.id);
      editsKept++;
    } else {
      deleteRow.run(row.id);
      editsDropped++;
    }
  }
})();

const plumbingDeleted = editRows.length - editsApplied - editsKept - editsDropped;

const revoked = db
  .prepare(
    `UPDATE messages SET message_type = 'deleted'
     WHERE message_type = 'unknown'
       AND json_extract(raw_json, '$.messageStubType') IN ('REVOKE', 'ADMIN_REVOKE')`
  )
  .run().changes;
const stubsDeleted = db
  .prepare(`DELETE FROM messages WHERE message_type = 'unknown'`)
  .run().changes;

console.log(
  `[cleanup] edits applied to originals: ${editsApplied}, kept standalone: ${editsKept}, ` +
    `dropped (no text): ${editsDropped}, protocol plumbing deleted: ${plumbingDeleted}`
);
console.log(`[cleanup] revokes kept as 'deleted' markers: ${revoked}, stub noise deleted: ${stubsDeleted}`);
